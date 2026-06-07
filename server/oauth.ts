/**
 * Self-hosted OAuth 2.1 provider so the MCP server can be added on claude.ai
 * as a custom connector with a one-click "Connect" flow.
 *
 * Design goals:
 *  - Zero external auth service. The whole flow runs inside this process.
 *  - Single shared secret (AUTH_TOKEN): the OAuth "login" step simply asks the
 *    user to paste that secret on a consent page. If correct, an access token
 *    is issued. This keeps the existing bearer-token model while giving
 *    claude.ai the standard OAuth experience it expects.
 *  - Stateless tokens: access/refresh tokens are HMAC-signed blobs, so they
 *    survive restarts with no storage.
 *  - Dynamic Client Registration (DCR) is persisted to disk (DATA_DIR) so
 *    claude.ai's registered client_id keeps working across restarts.
 *
 * The MCP spec flow claude.ai performs:
 *   GET /.well-known/oauth-protected-resource  -> finds the auth server
 *   GET /.well-known/oauth-authorization-server -> finds /authorize,/token,/register
 *   POST /register (DCR)                        -> gets a client_id
 *   GET /authorize (PKCE)                       -> our consent page -> code
 *   POST /token                                 -> access token
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { config } from './config.js';

const SIGNING_SECRET =
  process.env.OAUTH_SIGNING_SECRET || config.authToken || 'insecure-dev-secret';
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const CLIENTS_FILE = path.join(DATA_DIR, 'oauth-clients.json');

const nowSec = () => Math.floor(Date.now() / 1000);
const b64u = (input: crypto.BinaryLike) => Buffer.from(input as any).toString('base64url');

// ---------------------------------------------------------------------------
// Stateless signed tokens
// ---------------------------------------------------------------------------
interface TokenPayload {
  typ: 'access' | 'refresh';
  cid: string;
  scope: string;
  iat: number;
  exp: number;
}

function signToken(payload: TokenPayload): string {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token: string): TokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (payload.exp && payload.exp < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File-backed DCR clients store
// ---------------------------------------------------------------------------
class FileClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor() {
    try {
      const raw = fs.readFileSync(CLIENTS_FILE, 'utf8');
      for (const c of JSON.parse(raw) as OAuthClientInformationFull[]) {
        this.clients.set(c.client_id, c);
      }
    } catch {
      // No file yet — start empty.
    }
  }

  private persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CLIENTS_FILE, JSON.stringify([...this.clients.values()], null, 2));
    } catch (err) {
      process.stderr.write(`oauth: failed to persist clients: ${String(err)}\n`);
    }
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.clients.set(client.client_id, client);
    this.persist();
    return client;
  }
}

// ---------------------------------------------------------------------------
// Authorization codes (short-lived, in memory)
// ---------------------------------------------------------------------------
interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}
const codes = new Map<string, CodeRecord>();

function gc() {
  const t = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < t) codes.delete(k);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export class ScraperOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new FileClientsStore();

  /** Renders the consent/login page. The user proves they hold the secret. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(consentPage(client, params, false));
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = codes.get(authorizationCode);
    if (!rec) throw new Error('invalid_grant: unknown authorization code');
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    gc();
    const rec = codes.get(authorizationCode);
    if (!rec || rec.expiresAt < Date.now()) throw new Error('invalid_grant: code expired');
    if (rec.clientId !== client.client_id) throw new Error('invalid_grant: client mismatch');
    codes.delete(authorizationCode); // one-time use
    return this.issueTokens(client.client_id, rec.scopes.join(' '));
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const payload = verifyToken(refreshToken);
    if (!payload || payload.typ !== 'refresh') throw new Error('invalid_grant: bad refresh token');
    return this.issueTokens(client.client_id, scopes?.join(' ') ?? payload.scope);
  }

  /** Accepts OAuth-issued tokens AND the static AUTH_TOKEN. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (config.authToken && token === config.authToken) {
      return {
        token,
        clientId: 'static',
        scopes: ['mcp'],
        expiresAt: nowSec() + ACCESS_TTL,
      };
    }
    const payload = verifyToken(token);
    if (!payload || payload.typ !== 'access') throw new Error('invalid_token');
    return {
      token,
      clientId: payload.cid,
      scopes: payload.scope ? payload.scope.split(' ') : [],
      expiresAt: payload.exp,
    };
  }

  private issueTokens(cid: string, scope: string): OAuthTokens {
    const iat = nowSec();
    return {
      access_token: signToken({ typ: 'access', cid, scope, iat, exp: iat + ACCESS_TTL }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: signToken({ typ: 'refresh', cid, scope, iat, exp: iat + REFRESH_TTL }),
      scope: scope || undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Consent handling (custom route, posts back here)
// ---------------------------------------------------------------------------
export interface ConsentInput {
  secret: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope?: string;
}

export interface ConsentResult {
  ok: boolean;
  redirect?: string;
  html?: string;
}

/** Validates the posted secret and issues an authorization code. */
export function handleConsent(
  provider: ScraperOAuthProvider,
  input: ConsentInput,
): ConsentResult {
  const client = provider.clientsStore.getClient(input.client_id);
  if (!client) return { ok: false, html: errorPage('Unknown client.') };
  if (!client.redirect_uris.includes(input.redirect_uri)) {
    return { ok: false, html: errorPage('Invalid redirect_uri.') };
  }
  if (!config.authToken || input.secret !== config.authToken) {
    // Re-render the form with an error.
    return {
      ok: false,
      html: consentPage(
        client,
        {
          redirectUri: input.redirect_uri,
          codeChallenge: input.code_challenge,
          state: input.state,
          scopes: input.scope ? input.scope.split(' ') : [],
        },
        true,
      ),
    };
  }
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, {
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    scopes: input.scope ? input.scope.split(' ') : [],
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(input.redirect_uri);
  url.searchParams.set('code', code);
  if (input.state) url.searchParams.set('state', input.state);
  return { ok: true, redirect: url.toString() };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function consentPage(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  showError: boolean,
): string {
  const clientName = client.client_name || client.client_id;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize · App Store Scraper</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f1115;color:#e6e9ef;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:32px;max-width:380px;width:90%}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#8b93a3;font-size:13px;line-height:1.5;margin:0 0 18px}
  .who{color:#0a84ff;font-weight:600}
  label{display:block;font-size:12px;color:#8b93a3;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;background:#1f232c;border:1px solid #2a2f3a;color:#e6e9ef;border-radius:8px;padding:10px 12px;font-size:14px}
  button{margin-top:16px;width:100%;background:#0a84ff;border:none;color:#fff;padding:11px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
  .err{color:#ff453a;background:rgba(255,69,58,.1);border:1px solid rgba(255,69,58,.3);padding:9px 12px;border-radius:8px;font-size:12.5px;margin-bottom:14px}
  .logo{font-size:30px;text-align:center;margin-bottom:10px}
</style></head><body>
<form class="card" method="POST" action="/oauth/consent">
  <div class="logo">🍏</div>
  <h1>Authorize access</h1>
  <p><span class="who">${esc(clientName)}</span> wants to connect to your App Store Scraper MCP server.</p>
  ${showError ? '<div class="err">Invalid token. Please try again.</div>' : ''}
  <label for="secret">Access token</label>
  <input id="secret" name="secret" type="password" placeholder="Paste your AUTH_TOKEN" autofocus autocomplete="off" />
  <input type="hidden" name="client_id" value="${esc(client.client_id)}" />
  <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}" />
  <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}" />
  <input type="hidden" name="state" value="${esc(params.state ?? '')}" />
  <input type="hidden" name="scope" value="${esc((params.scopes ?? []).join(' '))}" />
  <button type="submit">Authorize</button>
</form></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Error</title>
<body style="font-family:sans-serif;background:#0f1115;color:#e6e9ef;padding:40px">
<h1>Authorization error</h1><p style="color:#ff453a">${esc(message)}</p></body>`;
}
