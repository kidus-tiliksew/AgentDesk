import { type ServiceCall, ServiceError, serviceClient, UpstreamError } from "./convex.js";
import { deleteConnection, devicePoll, deviceStart, getConnection } from "./device.js";
import type { Env } from "./env.js";
import { serveInstallScript } from "./install.js";
import { handleMcp } from "./mcp.js";

// component-gateway: AgentDesk's public origin. This slice serves `/mcp`, the
// installer's `/device/*` endpoints, and `/install.sh`; the discovery
// documents and `/v1` are not built yet.

type Handler = (request: Request, env: Env, svc: ServiceCall) => Response | Promise<Response>;

// Routes other than `/mcp`, which answers every method itself, by method and
// path. Any other pair is 404.
const ROUTES: Record<string, Handler> = {
  "POST /device/start": deviceStart,
  "POST /device/poll": devicePoll,
  "GET /device/connection": getConnection,
  "DELETE /device/connection": deleteConnection,
  "GET /install.sh": serveInstallScript,
};

export async function handle(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  const { pathname } = new URL(request.url);
  const handler = pathname === "/mcp" ? handleMcp : ROUTES[`${request.method} ${pathname}`];
  if (handler === undefined) {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  try {
    return await handler(request, env, svc);
  } catch (error) {
    // Convex could not answer, or answered a transport step with an error the
    // step does not expect, such as `rate_limited` while resolving a
    // credential. The response names no credential, session, or secret.
    if (error instanceof UpstreamError || error instanceof ServiceError) {
      return Response.json(
        { error: { code: "unavailable", message: "AgentDesk is temporarily unavailable" } },
        { status: 503 },
      );
    }
    console.error(error);
    return Response.json(
      { error: { code: "internal", message: "Internal error" } },
      { status: 500 },
    );
  }
}

export default {
  fetch(request, env) {
    return handle(request, env, serviceClient(env));
  },
} satisfies ExportedHandler<Env>;
