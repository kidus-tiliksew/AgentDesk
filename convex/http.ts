import { httpRouter } from "convex/server";
import { routes as agents } from "./agents/svc";
import { routes as decisions } from "./decisions/svc";
import { routes as identity } from "./identity/svc";
import { routes as notifications } from "./notifications/svc";

// component-backend-foundation §Composition: each domain owns its service
// routes, and the root declares no handler.
const http = httpRouter();

for (const route of [...agents, ...decisions, ...identity, ...notifications]) {
  http.route(route);
}

export default http;
