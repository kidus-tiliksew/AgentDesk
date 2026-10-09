import { errorCodeSchema } from "@agentdesk/contract";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getUserByClerkId } from "../identity/users";
import { appError } from "./errors";

// component-backend-foundation §Authentication of people: resolves the
// signed-in person's active account. Mutations that may run before the
// account exists call ensureUser instead.
export async function requireUser(ctx: Pick<QueryCtx, "auth" | "db">): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  const user = identity === null ? null : await getUserByClerkId(ctx, identity.subject);
  if (user === null) {
    throw appError(errorCodeSchema.enum.unauthenticated, "Not signed in");
  }
  return user;
}
