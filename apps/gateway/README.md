# @agentdesk/gateway

The Cloudflare Worker that serves AgentDesk's public origin (`component-gateway`). It authenticates each request and calls Convex service routes. It stores nothing.

This slice serves the remote MCP server at `POST /mcp`, `GET /mcp`, and `DELETE /mcp`, with the tools `ask`, `await`, `check`, `cancel`, `resolve`, and `status`. `ask` takes `interactive` (default `false`), set when the user may be watching the session and can answer in its chat. `resolve` relays an answer the user gave in the agent's chat: it takes `decision_id`, `answer`, and `chat_message`, the user's message word for word, and returns the answered decision with `answered_via: "chat"`. When the decision is no longer pending, it reads the decision once and returns the tool error `{"error": {"code": "conflict", "message": "Decision is already <state>"}, "decision": <Decision>}`, so the agent sees the recorded state and answer. Every response is JSON except a `tools/call` for `await`, which answers `text/event-stream`. It sends a `: keepalive` comment every 15 seconds while it polls the decision every 15 seconds, then one `message` event carrying the JSON-RPC response.

A tool error's `field` names the tool's own argument, such as `decision_id`, never a Convex argument such as `decisionId`. A refusal of the caller's user or session names no field. Once a `POST /mcp` body parses as a JSON-RPC request, a failure at any later step answers HTTP 200 with a JSON-RPC error `-32603` carrying the request's id. `error.data.code` is `unavailable` when Convex cannot answer, and the service's own code when it refuses a step such as `initialize`. A refused credential still answers 401 with its challenge.

It also serves the [public HTTP API](#public-http-api) under `/v1` and the [installer endpoints](#installer-endpoints): `/device/*` and `/install.sh`. Clerk OAuth tokens and the `/.well-known` discovery documents are not built yet. A connection token (`adc_…`) is accepted on `/mcp` and `/device/*`, and an API token (`adp_…`) only on `/v1`.

## Public HTTP API

`src/v1.ts` serves the operations of the contract's route table (`packages/contract/src/http/routes.ts#ROUTES`), registered by route id, so the served API and `spec/openapi.json` cannot diverge:

| Route | Operation |
| --- | --- |
| `GET /v1/decisions` | `decisions.list`, filtered by `state` and `topic`, newest first, paged with `cursor` and `limit` (1 to 100, default 50) |
| `GET /v1/decisions/{decision_id}` | `decisions.get` |
| `POST /v1/decisions/{decision_id}/answer` | `decisions.answer`, body `{answer, note}`, recorded with `answered_via: "api"` |
| `POST /v1/decisions/{decision_id}/cancel` | `decisions.cancel` |
| `GET /v1/agent-sessions` | `agent_sessions.list`: live sessions first, then sessions ended in the last 7 days |
| `GET /v1/agent-sessions/{agent_session_id}` | `agent_sessions.get` |

- Every request carries `Authorization: Bearer adp_…`, resolved through `/svc/identity/resolve-token` on every request. A missing, malformed, unknown, or revoked token, a connection token, and an `adp_` token of another kind answer 401 with `WWW-Authenticate: Bearer`.
- The `API_LIMIT` binding allows 120 requests a minute per API token, keyed by its credential id after authentication. Over the limit answers 429 `rate_limited`. Without the binding, `/v1` answers 503 rather than run unlimited.
- Path, query, and body are validated with the route's contract schemas. A failure answers 400 `invalid` naming the field. Service refusals keep their code with the status `ERROR_STATUS` names: 404 `not_found`, 409 `conflict` for a decision that is no longer pending. A service field is restated as the public one, such as `decision_id`.
- A page's `next_cursor` is `null` on the last page. Keep the other filters unchanged while paging; a cursor reused with other filters answers 400 naming `cursor`.
- Any other method and path under `/v1` answers 404.

## Installer endpoints

The `agentdesk` installer (`packages/installer`) signs each harness in by short code and checks or revokes its connection through these routes. Any other method on these paths answers 404. Errors carry `{"error": {"code", "message", "field"}}`, and a Convex outage answers 503 `unavailable`.

| Route | Request | Answers |
| --- | --- | --- |
| `POST /device/start` | `{machine_name, harnesses}` | 200 `{user_code, device_secret, interval: 2, expires_in: 600}`, with `user_code` as identity's 8 bare symbols, which the installer displays as `XXXX-XXXX`; 400 `invalid` naming the field; 429 `rate_limited` |
| `POST /device/poll` | `{device_secret}` | 200 `{status}`, where `status` is `pending`, `declined`, `expired`, `not_found`, or `approved` with `connections: [{harness, connection_id, token}]`; 400 `invalid` |
| `GET /device/connection` | `Authorization: Bearer adc_…` | 200 `{connection_id, harness}`; 401 `unauthenticated` |
| `DELETE /device/connection` | `Authorization: Bearer adc_…` | 200 `null` once revoked; 401 `unauthenticated` |
| `POST /device/wait` | `Authorization: Bearer adc_…`, `{decision_id, timeout_seconds}` | 200 `text/event-stream` with one `message` event; 400 `invalid` naming the field; 401 `unauthenticated` |
| `GET /install.sh` | none | 200, the install script as `text/plain` |

- `/device/start` trims `machine_name` and requires 1 to 255 characters. `harnesses` must be a non-empty list of distinct ids from `claude-code`, `codex`, and `cursor`. The `DEVICE_START_LIMIT` binding allows 10 starts a minute per `CF-Connecting-IP`, counted before the body is read. Without the binding or that header, the route answers 503 rather than run unlimited.
- `/device/poll` passes identity's status through. `not_found` means the secret is unknown or its outcome was already collected: an approved request's tokens are returned once. Both `/device/start` and `/device/poll` answer with `Cache-Control: no-store`, since they carry secrets.
- `/device/connection` resolves the token on every request, so a revoked connection fails its next check. `DELETE` sends Convex only the token's SHA-256. Its 401, unlike `/mcp`'s, carries no `WWW-Authenticate` challenge, because the challenge starts browser sign-in.
- `/device/wait` serves the resume waiter (`agentdesk wait`) and opens no agent session. `timeout_seconds` is an integer from 1 to 600, 300 when omitted. It polls `/svc/decisions/watch` at once and every 15 seconds on `await`'s schedule and sends a `: keepalive` comment every 15 seconds. The single event is `{"decision": <Decision>}` once settled, `{"state": "pending", "decision_id"}` at the limit, or `{"error": …}`: `not_found` for an unknown decision, and `unavailable` when Convex fails after the stream opened. An error's `field` names the body field, such as `decision_id`.
- `test/installer-compatibility.test.ts` runs the installer's own `signIn` (`packages/installer/src/signin.ts`) through these routes with Convex faked, so a wire-format change on either side fails here. `test/waiter-compatibility.test.ts` does the same for the installer's `runWait` (`packages/installer/src/resume/waiter.ts`) through `/device/wait`.
- `/install.sh` serves `packages/installer/install.sh`, bundled at build time by the Text module rule in `wrangler.toml`, with `__AGENTDESK_PUBLIC_ORIGIN__` replaced by `PUBLIC_ORIGIN` without trailing slashes. The gateway keeps no copy of the script.

## Configuration

`wrangler.toml` declares the variables and their local defaults:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | the public URL. It names the 401 challenge's metadata document, is the allowed browser `Origin`, and is the server `/install.sh` names |
| `CONVEX_SITE_URL` | the Convex deployment's HTTP actions origin, ending in `.convex.site` |
| `CLERK_PUBLISHABLE_KEY` | Clerk application key, unused until OAuth verification is built |

It also declares the `DEVICE_START_LIMIT` rate-limit binding, 10 calls per 60 seconds, which `/device/start` keys by client IP, and the `API_LIMIT` binding, 120 calls per 60 seconds, which `/v1` keys by API credential.

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

5. For the HTTP API, mint an API token the same way. No app creates API tokens yet:

   ```sh
   npx convex run identity/devMint:mintApiToken \
     '{"clerkUserId": "user_<id>", "email": "developer@example.com", "name": "Local API checks"}'
   ```

   The result's `token` (`adp_…`) is shown once. List the user's pending decisions with it:

   ```sh
   curl -H "Authorization: Bearer adp_…" 'http://localhost:8787/v1/decisions?state=pending'
   ```

`identity/devMint:mintConnectionToken`, `identity/devMint:mintApiToken`, and `decisions/devAnswer:answer` are internal functions. Only the dashboard or a Convex CLI with access to the deployment can call them. To settle a decision by hand, as the smoke run does:

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
2. `tools/list`, which must return exactly `ask`, `await`, `check`, `cancel`, `resolve`, and `status`;
3. `status` with state `working` on topic `smoke/mcp`, keeping the agent session id it returns;
4. the relayed leg: `ask` for an approve-or-reject decision with `interactive: true`, then `resolve` with `approve` and a fixed chat message. The decision must be `answered` with `answered_via: "chat"`, `interactive: true`, the message unchanged, and `relayed_by_agent_session_id` equal to the `status` session id. A second `resolve` with `reject` must return a `conflict` tool error carrying the decision with the first answer and message;
5. the answered leg: `ask` for an approve-or-reject decision with no deadline, then `await`. Once the stream is open, it runs `npx convex run decisions/devAnswer:answer` from the repository root. `await` must return `answered` with the answer and note, within 30 seconds of the answer;
6. the default leg, skipped by `--quick`: `ask` with a deadline five minutes ahead and the default `reject`, then one `await` with `timeout_seconds: 330`. It must return `expired` with the default and `applied_by_default: true`. The decision must carry the requested deadline and an `answered_at` no earlier than it. `await` must not return sooner than 5 seconds before the deadline on this machine's clock, which allows for skew against the deployment's clock. Keepalive comments must arrive throughout the wait, never more than 30 seconds apart, so a proxy that buffers an idle stream fails the run.

Ctrl-C, or a failure of the `await` stream while the answer helper runs, terminates the helper's process group and waits for it to exit before the run ends. The helper is given 120 seconds.

Each passing step prints one line. The default leg's line reports the keepalive count, the first and last arrival, and the largest gap. On a mismatch the run prints `FAIL <step>: <reason>` and exits 1. It never prints the token. The Convex CLI in step 5 must act on the deployment that the gateway's `CONVEX_SITE_URL` names; otherwise the answer helper fails to find the decision. Each run leaves three decisions and a session on the dev deployment.

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
| `pnpm --filter @agentdesk/gateway typecheck` | strict TypeScript over `src/` and `test/` with Workers types, over `test/installer-compatibility.test.ts` with Workers and Node types (`tsconfig.compat.json`), and over `scripts/` with Node types |
| `pnpm --filter @agentdesk/gateway dev` | `wrangler dev` |
| `pnpm --filter @agentdesk/gateway smoke:mcp` | the [smoke run](#smoke-run) against a running gateway |
