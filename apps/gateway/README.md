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

## Dev deployment prerequisites

The smoke run and the Claude Code entry below need a Convex dev deployment, a gateway pointed at it, and a connection token. Each step uses an existing mechanism; nothing here provisions them for you.

1. Select the Convex dev deployment from the repository root. `npx convex dev` signs in and writes `CONVEX_DEPLOYMENT` to the git-ignored `.env.local`. Every later `npx convex` command run from the root acts on that deployment.
2. Set the service secret on that deployment. Generate a random value of your own:

   ```sh
   npx convex env set SERVICE_SECRET <random-secret>
   ```

3. Write `apps/gateway/.dev.vars` as [Local development](#local-development) shows: `CONVEX_SITE_URL` is that deployment's `.convex.site` origin, and `SERVICE_SECRET` is the same value. Start the gateway with `pnpm dev` or `pnpm --filter @agentdesk/gateway dev`.
4. Mint a connection token from the repository root. `clerkUserId` names the user that owns the token; the mint creates the user when none exists:

   ```sh
   npx convex run identity/devMint:mintConnectionToken \
     '{"clerkUserId": "user_<id>", "email": "developer@example.com", "harness": "claude-code", "name": "Claude Code"}'
   ```

   The result's `token` (`adc_…`) is shown once. Treat it as a password.

`identity/devMint:mintConnectionToken` and `decisions/devAnswer:answer` are internal functions. Only the dashboard or a Convex CLI with access to the deployment can call them. To settle a decision by hand, as the smoke run does:

```sh
npx convex run decisions/devAnswer:answer \
  '{"decisionId": "<decision_id>", "answer": {"kind": "approve"}, "note": "Looks good", "answeredVia": "app"}'
```

## Smoke run

`scripts/smoke-mcp.ts` checks a running gateway and its dev deployment end to end, speaking Streamable HTTP as a plain client. From the repository root:

```sh
AGENTDESK_GATEWAY_URL=http://localhost:8787 AGENTDESK_CONNECTION_TOKEN=adc_… \
  pnpm --filter @agentdesk/gateway smoke:mcp
```

Append `--quick` to skip the five-minute leg while iterating. `smoke:mcp` runs `pnpm dlx tsx@4.23.15`, so the first run downloads `tsx`. The run takes a little over five minutes and does, in order:

1. `initialize`, keeping `Mcp-Session-Id`, then `notifications/initialized`;
2. `tools/list`, which must return exactly `ask`, `await`, `check`, `cancel`, and `status`;
3. `status` with state `working` on topic `smoke/mcp`;
4. the answered leg: `ask` for an approve-or-reject decision with no deadline, then `await`. Once the stream is open, it runs `npx convex run decisions/devAnswer:answer` from the repository root. `await` must return `answered` with the answer and note, within 30 seconds of the answer;
5. the default leg, skipped by `--quick`: `ask` with a deadline five minutes ahead and the default `reject`, then one `await` with `timeout_seconds: 330`. It must return `expired` with the default and `applied_by_default: true`. Keepalive comments must arrive throughout the wait, never more than 30 seconds apart, so a proxy that buffers an idle stream fails the run.

Each passing step prints one line. The default leg's line reports the keepalive count, the first and last arrival, and the largest gap. On a mismatch the run prints `FAIL <step>: <reason>` and exits 1. It never prints the token. The Convex CLI in step 4 must act on the deployment that the gateway's `CONVEX_SITE_URL` names; otherwise the answer helper fails to find the decision. Each run leaves two decisions and a session on the dev deployment.

The live run is never part of CI, which has no gateway or service secret. `test/smoke-mcp.test.ts` runs the same steps against a fake gateway on a fake clock.

## Connect Claude Code

This is the Phase 1 developer path. Point Claude Code at a running gateway with a token minted as above:

```sh
claude mcp add --transport http agentdesk <gateway-url>/mcp --header "Authorization: Bearer <token>"
```

The equivalent project `.mcp.json` entry:

```json
{
  "mcpServers": {
    "agentdesk": {
      "type": "http",
      "url": "<gateway-url>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Typing a token is a stopgap. This entry does not meet `req-accounts-and-connections` REQ-3 or REQ-6. Phase 3's installer and Phase 5's browser sign-in replace it.

## Commands

| Command | Runs |
| --- | --- |
| `pnpm --filter @agentdesk/gateway test` | the Workers-runtime tests in `test/` under `@cloudflare/vitest-pool-workers`, with the Convex client faked |
| `pnpm --filter @agentdesk/gateway typecheck` | strict TypeScript over `src/` and `test/` with Workers types, and over `scripts/` with Node types |
| `pnpm --filter @agentdesk/gateway dev` | `wrangler dev` |
| `pnpm --filter @agentdesk/gateway smoke:mcp` | the [smoke run](#smoke-run) against a running gateway |
