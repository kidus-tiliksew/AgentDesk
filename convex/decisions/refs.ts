import { type ApiFromModules, anyApi } from "convex/server";
import type * as app from "./app";
import type * as devAnswer from "./devAnswer";
import type * as expire from "./expire";
import type * as operations from "./operations";

// Typed references to this domain's functions, built from the module types
// rather than convex/_generated/api.d.ts, so adding a function here needs no
// edit to the generated declarations that component-backend-foundation owns.
// The imports are type-only, so this module loads no function code.
type DecisionsApi = ApiFromModules<{
  "decisions/app": typeof app;
  "decisions/devAnswer": typeof devAnswer;
  "decisions/expire": typeof expire;
  "decisions/operations": typeof operations;
}>["decisions"];

export const decisions = anyApi.decisions as unknown as DecisionsApi;
