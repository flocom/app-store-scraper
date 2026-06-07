# Deployment — GUI · REST · MCP behind a Cloudflare Tunnel

This repo ships three runtime surfaces from a single Node server
([`server/http.ts`](server/http.ts)):

| Surface | Path                | Auth                  |
| ------- | ------------------- | --------------------- |
| Web GUI | `/`                 | public                |
| REST    | `/api/<method>`     | Bearer token          |
| MCP     | `/mcp` (POST)       | Bearer token          |
| Health  | `/healthz`          | public                |

The 10 scraper methods (`app`, `list`, `search`, `developer`, `reviews`,
`ratings`, `similar`, `suggest`, `privacy`, `versionHistory`) are defined once
in [`server/methods.ts`](server/methods.ts) and shared by REST + MCP.

Target public URL: **https://mcp.example.com**

---

## 1. Run locally (no Docker)

```bash
npm install
AUTH_TOKEN=$(openssl rand -hex 32) npm run server
# GUI:  http://localhost:8080/
# REST: curl -H "Authorization: Bearer <token>" -d '{"term":"weather"}' \
#         -H 'Content-Type: application/json' http://localhost:8080/api/search
```

Without `AUTH_TOKEN`, `/api` and `/mcp` are **open** (dev only — a warning is
logged).

---

## 2. Run with Docker + Cloudflare Tunnel

### 2.1 Prerequisites

- Docker + Docker Compose
- A Cloudflare account with the **example.com** zone added
- The `cloudflared` connector runs as a container — nothing to install locally

### 2.2 Create the tunnel (Option A — token, recommended)

Remotely-managed tunnel; routing is configured in the dashboard.

1. Cloudflare **Zero Trust** dashboard → **Networks → Tunnels → Create a tunnel**.
2. Type **Cloudflared**, name it e.g. `appstore-scraper`, **Save**.
3. On the **Install connector** screen, choose **Docker**. Copy the long value
   that follows `--token` — that is your `TUNNEL_TOKEN`.
4. **Public Hostname** tab → **Add a public hostname**:
   - Subdomain: `appstore-scraper`
   - Domain: `example.com`
   - Type: `HTTP`
   - URL: `app:8080`  ← the compose service name + port
5. Save. Cloudflare auto-creates the `appstore-scraper` CNAME DNS record.

### 2.3 Configure & launch

```bash
cp .env.example .env
# edit .env:
#   AUTH_TOKEN=<openssl rand -hex 32>
#   TUNNEL_TOKEN=<value copied in step 3>

docker compose up -d --build
docker compose logs -f cloudflared   # expect "Registered tunnel connection"
```

Verify:

```bash
curl https://mcp.example.com/healthz
curl -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' -d '{"term":"weather","num":3}' \
  https://mcp.example.com/api/search
```

The GUI is at https://mcp.example.com/ — paste the token in the
top-right box.

### 2.4 Option B — CLI locally-managed tunnel (alternative)

If you prefer credentials files over a dashboard token:

```bash
cloudflared tunnel login
cloudflared tunnel create appstore-scraper        # prints <TUNNEL_ID> + .json
cloudflared tunnel route dns appstore-scraper mcp.example.com
```

- Put the generated `<TUNNEL_ID>.json` into `./cloudflared/`.
- Edit [`cloudflared/config.yml`](cloudflared/config.yml), replacing
  `<TUNNEL_ID>`.
- Swap the `cloudflared` service in `docker-compose.yml` to mount the config and
  run the named tunnel instead of using `TUNNEL_TOKEN`:

  ```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
    volumes:
      - ./cloudflared:/etc/cloudflared:ro
    depends_on: [app]
    networks: [internal]
  ```

---

## 3. Connect an MCP client

### claude.ai — custom connector (OAuth, one-click)

The server self-hosts an OAuth 2.1 authorization server (Dynamic Client
Registration + PKCE), so claude.ai can add it like any official connector — no
token pasting in the UI.

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `App Store Scraper` · URL:
   `https://mcp.example.com/mcp`
3. Click **Add**, then **Connect**. A browser window opens our consent page.
4. Paste your **`AUTH_TOKEN`** (the shared secret from `.env`) and click
   **Authorize**. Done — the 10 tools appear in Claude.

How it works under the hood (all served by this app):

```
/.well-known/oauth-protected-resource   discovery (RFC 9728)
/.well-known/oauth-authorization-server  discovery (RFC 8414)
/register   Dynamic Client Registration
/authorize  consent page (asks for AUTH_TOKEN)
/token      PKCE code -> access + refresh tokens
```

> Requires `AUTH_TOKEN` **and** a public `PUBLIC_URL` (the OAuth issuer must
> match the URL claude.ai talks to). Both are set by `docker compose`.
> DCR clients are persisted in the `oauth-data` volume so the connector keeps
> working across restarts.

### Remote (HTTP, through the tunnel)

Any MCP client that supports **streamable HTTP** with auth headers:

```json
{
  "mcpServers": {
    "app-store-scraper": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Add it to Claude Code with:

```bash
claude mcp add --transport http app-store-scraper \
  https://mcp.example.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

### Local (stdio, Claude Desktop)

```json
{
  "mcpServers": {
    "app-store-scraper": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/app-store-scraper/server/stdio.ts"]
    }
  }
}
```

---

## 4. Security notes

- `app` is never published on a host port; only `cloudflared` reaches it over the
  internal Docker network. The bearer token guards `/api` and `/mcp`.
- Rotate `AUTH_TOKEN` by editing `.env` and `docker compose up -d`.
- For stronger protection, layer **Cloudflare Access** in front of the hostname
  (Zero Trust → Access → Applications) in addition to the token.
- `/healthz` and the GUI are intentionally public; the GUI makes no calls
  without a token.
