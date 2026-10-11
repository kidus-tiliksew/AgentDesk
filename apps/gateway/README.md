# @agentdesk/gateway

The Cloudflare Worker that serves AgentDesk's public origin (`component-gateway`). It authenticates each request and calls Convex service routes. It stores nothing.

This slice serves the remote MCP server at `POST /mcp`, `GET /mcp`, and `DELETE /mcp`, with the tools `ask`, `await`, `check`, `cancel`, and `status`. Every response is JSON except a `tools/call` for `await`, which answers `text/event-stream`. It sends a `: keepalive` comment every 15 seconds while it polls the decision every 15 seconds, then one `message` event carrying the JSON-RPC response. Clerk OAuth tokens, the `/.well-known` discovery documents, the `/v1` HTTP API, `/device/*`, and `/install.sh` are not built yet. A connection token (`adc_…`) is the only accepted credential.

## Configuration

`wrangler.toml` declares the variables and their local defaults:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | the public URL. It names the 401 challenge's metadata document and is the allowed browser `Origin` |
| `CONVEX_SITE_URL` | the Convex deployment's HTTP actions origin, ending in `.convex.site` |
| `CLERK_PUBLISHABLE_KEY` | Clerk application key, unused until OAuth verification is built |

Secrets are never committed:

| Secret | Purpose |
| --- | --- |
| `SERVICE_SECRET` | sent as `Authorization: Bearer` on every service call; must equal the Convex deployment's `SERVICE_SECRET` |
| `CLERK_SECRET_KEY` | Clerk Backend API key, unused until OAuth verification is built |

Set them for a deployed Worker with `wrangler secret put SERVICE_SECRET` and `wrangler secret put CLERK_SECRET_KEY`.

## Local development

`wrangler dev` reads secrets and variable overrides from `apps/gateway/.dev.vars`. The root `.gitignore` ignores `.dev.vars*`. Create the file with:

```sh
# apps/gateway/.dev.vars
CONVEX_SITE_URL=https://<your-dev-deployment>.convex.site
SERVICE_SECRET=<the SERVICE_SECRET set on that Convex deployment>
CLERK_SECRET_KEY=
```

Then run either:

- `pnpm dev` from the repository root, which runs `scripts/dev.mjs`. It starts `convex dev` and this Worker together. When either exits, or on Ctrl-C, it stops the other;
- `pnpm --filter @agentdesk/gateway dev` for the Worker alone, on `http://localhost:8787`.

To reach it from an MCP client, mint a connection token on the dev deployment (`component-identity` §Development mint) and send it as `Authorization: Bearer adc_…` to `http://localhost:8787/mcp`.

## Commands

| Command | Runs |
| --- | --- |
| `pnpm --filter @agentdesk/gateway test` | the Workers-runtime tests in `test/` under `@cloudflare/vitest-pool-workers`, with the Convex client faked |
| `pnpm --filter @agentdesk/gateway typecheck` | strict TypeScript over `src/` and `test/` |
| `pnpm --filter @agentdesk/gateway dev` | `wrangler dev` |
