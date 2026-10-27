import { errorCodeSchema } from "@agentdesk/contract";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { appError } from "../lib/errors";
import { getOwned } from "../lib/owned";
import { isMacCredential } from "./clients";
import { revokeCredential } from "./credentials";

// component-identity §Credentials: the app's connection functions
// (req-accounts-and-connections REQ-4). The app calls Convex as the signed-in
// person, so each function resolves the account with requireUser and takes no
// user id from the client.

// The credential kinds a harness connects with. An API token is a connection
// only when a Mac sign-in minted it (req-mac-app AC-2.5); every other API
// token never appears here.
const CONNECTION_KINDS = ["connection_token", "connection_oauth"] as const;

function isConnection(credential: Doc<"credentials">): boolean {
  return (
    (CONNECTION_KINDS as readonly string[]).includes(credential.kind) || isMacCredential(credential)
  );
}

// One connected harness client as the connections screen shows it
// (req-accounts-and-connections AC-4.1). `firstConnectedAt` is the
// credential's creation time. `lastUsedAt` is written at most once a minute,
// so it is accurate to the minute; it is absent until the first resolve.
export type Connection = {
  credentialId: Id<"credentials">;
  name: string;
  machineName?: string;
  firstConnectedAt: number;
  lastUsedAt?: number;
};

// The fallback name for a credential that stores neither a name nor a harness.
export const UNKNOWN_CLIENT = "Unknown client";

// An explicit projection, so the token hash and other credential fields never
// reach the client.
function toConnection(credential: Doc<"credentials">): Connection {
  const connection: Connection = {
    credentialId: credential._id,
    name: credential.name ?? credential.harness ?? UNKNOWN_CLIENT,
    firstConnectedAt: credential._creationTime,
  };
  if (credential.machineName !== undefined) {
    connection.machineName = credential.machineName;
  }
  if (credential.lastUsedAt !== undefined) {
    connection.lastUsedAt = credential.lastUsedAt;
  }
  return connection;
}

// Newest first connection first; the credential id breaks ties, so the order
// is total across both kinds.
export function byFirstConnected(a: Connection, b: Connection): number {
  if (a.firstConnectedAt !== b.firstConnectedAt) {
    return b.firstConnectedAt - a.firstConnectedAt;
  }
  return a.credentialId < b.credentialId ? -1 : a.credentialId > b.credentialId ? 1 : 0;
}

// The signed-in person's connected clients: every connection_token and
// connection_oauth credential, and every Mac's API token, without `revokedAt`,
// newest first. The query is reactive, so a revoked connection leaves the list
// on the app's next render.
export const listConnections = query({
  args: {},
  handler: async (ctx): Promise<Connection[]> => {
    const user = await requireUser(ctx);
    const connections: Connection[] = [];
    for (const kind of [...CONNECTION_KINDS, "api_token"] as const) {
      const credentials = await ctx.db
        .query("credentials")
        .withIndex("by_user_kind", (q) => q.eq("userId", user._id).eq("kind", kind))
        .collect();
      for (const credential of credentials) {
        if (credential.revokedAt === undefined && isConnection(credential)) {
          connections.push(toConnection(credential));
        }
      }
    }
    return connections.sort(byFirstConnected);
  },
});

function notFound(): never {
  throw appError(errorCodeSchema.enum.not_found, "Connection not found");
}

// Revokes one of the signed-in person's connections, so the gateway refuses
// its next tool call (req-accounts-and-connections AC-4.2). The argument is
// validated in the handler rather than with v.id, so an omitted or malformed
// id answers `not_found` like a missing, a foreign, or another API token's id
// (AC-1.1). A Mac's API token is a connection and revokes (req-mac-app
// AC-2.5). Revoking an already revoked connection succeeds and keeps the first
// `revokedAt`.
export const revokeConnection = mutation({
  args: { credentialId: v.optional(v.any()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx);
    const raw: unknown = args.credentialId;
    const credentialId = typeof raw === "string" ? ctx.db.normalizeId("credentials", raw) : null;
    if (credentialId === null) {
      notFound();
    }
    const credential = await getOwned(ctx, "credentials", credentialId, user._id);
    // Another API token is not a connection, so this surface does not reveal it.
    if (credential === null || !isConnection(credential)) {
      notFound();
    }
    await revokeCredential(ctx, user._id, credentialId);
    return null;
  },
});
