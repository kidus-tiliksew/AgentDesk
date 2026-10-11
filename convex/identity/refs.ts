import { type ApiFromModules, anyApi } from "convex/server";
import type * as accounts from "./accounts";
import type * as connections from "./connections";

// Typed references to this domain's functions, built from the module types
// rather than convex/_generated/api.d.ts, so adding a function here needs no
// edit to the generated declarations that component-backend-foundation owns.
// The imports are type-only, so this module loads no function code. The
// mobile app imports this module too, so it needs no local codegen.
type IdentityApi = ApiFromModules<{
  "identity/accounts": typeof accounts;
  "identity/connections": typeof connections;
}>["identity"];

export const identity = anyApi.identity as unknown as IdentityApi;
