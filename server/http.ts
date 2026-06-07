#!/usr/bin/env node
/**
 * HTTP entrypoint.
 *
 * Serves these surfaces from one process:
 *   1. GET  /                — the web GUI (static, from ../web)
 *   2. /api/*                — REST API, one route per scraper method
 *   3. POST /mcp             — MCP server over streamable HTTP (stateless)
 *   4. OAuth 2.1 endpoints   — so claude.ai can add this as a custom connector
 *      (/.well-known/*, /authorize, /token, /register, /oauth/consent)
 *
 * /api and /mcp are protected by a bearer token when AUTH_TOKEN is set.
 * /mcp additionally accepts OAuth-issued access tokens (claude.ai flow).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config, authEnabled } from './config.js';
import { buildMcpServer } from './mcp.js';
import { methods, getMethod, schemaFor } from './methods.js';
import { ScraperOAuthProvider, handleConsent } from './oauth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, '..', 'web');

// Public origin used as the OAuth issuer / resource identifier. Must be the
// externally reachable HTTPS URL for claude.ai (set PUBLIC_URL in production).
const issuerUrl = new URL(
  config.publicUrl ||
    `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
);
const resourceMetadataUrl = new URL(
  '/.well-known/oauth-protected-resource',
  issuerUrl,
).toString();

const app = express();
app.set('trust proxy', true); // behind the Cloudflare tunnel
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled) return next();
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Also accept ?token= for convenience from the GUI / browser tools.
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (token === config.authToken || queryToken === config.authToken) return next();
  res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>.' });
}

// ---------------------------------------------------------------------------
// Health (public)
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', authEnabled, methods: methods.map((m) => m.name) });
});

// ---------------------------------------------------------------------------
// OAuth 2.1 (only when a secret is configured — enables claude.ai connector)
// ---------------------------------------------------------------------------
const oauthProvider = new ScraperOAuthProvider();
if (authEnabled) {
  // Mounts /.well-known/oauth-authorization-server,
  // /.well-known/oauth-protected-resource, /authorize, /token, /register,
  // /revoke — everything claude.ai needs to discover and connect.
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      resourceServerUrl: issuerUrl,
      resourceName: 'App Store Scraper',
      scopesSupported: ['mcp'],
    }),
  );

  // Consent form post-back (the user pastes the shared secret here).
  app.post(
    '/oauth/consent',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const result = handleConsent(oauthProvider, {
        secret: String(req.body.secret ?? ''),
        client_id: String(req.body.client_id ?? ''),
        redirect_uri: String(req.body.redirect_uri ?? ''),
        code_challenge: String(req.body.code_challenge ?? ''),
        state: req.body.state ? String(req.body.state) : undefined,
        scope: req.body.scope ? String(req.body.scope) : undefined,
      });
      if (result.ok && result.redirect) {
        res.redirect(302, result.redirect);
      } else {
        res.status(result.html ? 401 : 400);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(result.html ?? 'Bad request');
      }
    },
  );
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// Machine-readable catalogue of methods (drives the GUI forms).
app.get('/api/methods', requireAuth, (_req, res) => {
  res.json(
    methods.map((m) => ({
      name: m.name,
      title: m.title,
      description: m.description,
      schema: z.toJSONSchema(schemaFor(m)),
    })),
  );
});

// One handler for every method. Accepts args from JSON body (POST) or query
// string (GET). Numeric/boolean query values are coerced before validation.
async function handleMethod(req: Request, res: Response) {
  const methodName = String(req.params.method ?? '');
  const def = getMethod(methodName);
  if (!def) {
    res.status(404).json({ error: `Unknown method: ${methodName}` });
    return;
  }
  const raw = req.method === 'GET' ? coerceQuery(req.query) : (req.body ?? {});
  const parsed = schemaFor(def).safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid arguments', issues: parsed.error.issues });
    return;
  }
  try {
    const result = await def.handler(parsed.data);
    res.json({ method: def.name, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
}

// Coerce query string values ("123" -> 123, "true" -> true) so GET works.
function coerceQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'token') continue;
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    if (v === 'true') out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (v !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

app.get('/api/:method', requireAuth, handleMethod);
app.post('/api/:method', requireAuth, handleMethod);

// ---------------------------------------------------------------------------
// MCP over streamable HTTP (stateless: new server + transport per request)
// ---------------------------------------------------------------------------
async function handleMcp(req: Request, res: Response) {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

// /mcp accepts EITHER the static AUTH_TOKEN or an OAuth-issued access token.
// On 401 it returns WWW-Authenticate with resource_metadata, which is what
// triggers claude.ai to start the OAuth connect flow.
const mcpAuth: express.RequestHandler[] = authEnabled
  ? [requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl })]
  : [];

app.post('/mcp', ...mcpAuth, handleMcp);
// Stateless mode: GET/DELETE are not supported (no long-lived SSE sessions).
app.get('/mcp', ...mcpAuth, (_req, res) =>
  res.status(405).json({ error: 'Method Not Allowed (stateless MCP — use POST)' }),
);

// ---------------------------------------------------------------------------
// Static GUI (public)
// ---------------------------------------------------------------------------
app.use(express.static(webDir));

app.listen(config.port, config.host, () => {
  const where = `http://${config.host}:${config.port}`;
  process.stdout.write(`app-store-scraper server listening on ${where}\n`);
  process.stdout.write(`  GUI:   ${where}/\n`);
  process.stdout.write(`  REST:  ${where}/api/<method>\n`);
  process.stdout.write(`  MCP:   ${where}/mcp (POST)\n`);
  if (authEnabled) {
    process.stdout.write(`  OAuth: issuer ${issuerUrl.origin} (claude.ai connector ready)\n`);
  } else {
    process.stdout.write('  ⚠️  AUTH_TOKEN is not set — /api and /mcp are OPEN, OAuth disabled.\n');
  }
});
