import { type ApiFromModules, anyApi } from "convex/server";
import type * as api from "./api";
import type * as app from "./app";
import type * as purge from "./purge";
import type * as sessions from "./sessions";
import type * as sweep from "./sweep";

// Typed references to this domain's functions, built from the module types
// rather than convex/_generated/api.d.ts, so adding a function here needs no
// edit to the generated declarations that component-backend-foundation owns.
// The imports are type-only, so this module loads no function code.
type AgentsApi = ApiFromModules<{
  "agents/api": typeof api;
  "agents/app": typeof app;
  "agents/purge": typeof purge;
  "agents/sessions": typeof sessions;
  "agents/sweep": typeof sweep;
}>["agents"];

export const agents = anyApi.agents as unknown as AgentsApi;
