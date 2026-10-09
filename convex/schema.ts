import { defineSchema } from "convex/server";
import { tables as agents } from "./agents/schema";
import { tables as decisions } from "./decisions/schema";
import { tables as identity } from "./identity/schema";
import { tables as notifications } from "./notifications/schema";

// component-backend-foundation §Composition: each domain owns its tables, and
// the root declares none.
export default defineSchema({
  ...agents,
  ...decisions,
  ...identity,
  ...notifications,
});
