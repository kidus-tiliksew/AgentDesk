import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { ensureUser } from "./users";

// component-identity §Accounts. The app calls ensureAccount once after sign-in
// and before any other Convex call, so the first sign-in creates the `users`
// row (req-accounts-and-connections AC-2.1) and every later requireUser finds
// it. The Clerk identity alone selects the account; the call takes no
// arguments. A deleting account is refused with `unauthenticated`.
export const ensureAccount = mutation({
  args: {},
  returns: v.object({
    _id: v.id("users"),
    _creationTime: v.number(),
    clerkUserId: v.string(),
    email: v.string(),
    deletingAt: v.optional(v.number()),
  }),
  handler: async (ctx) => await ensureUser(ctx),
});
