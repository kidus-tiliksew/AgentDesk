import { type ServiceCall, ServiceError, serviceClient, UpstreamError } from "./convex.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";

// component-gateway: AgentDesk's public origin. This slice serves `/mcp`; the
// discovery documents, `/v1`, `/device/*`, and `/install.sh` are not built yet.
export async function handle(request: Request, env: Env, svc: ServiceCall): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  try {
    return await handleMcp(request, env, svc);
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
