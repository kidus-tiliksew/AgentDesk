import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { refusalEnd } from "./accountDeletion";
import { RETRY_BASE_MS, RETRY_MAX_MS } from "./clerkDeletion";
import { identity } from "./refs";

// component-identity §PostHog person deletion (req-accounts-and-connections
// AC-5.2, DEC-22(4)): asking PostHog to delete the account's person and that
// person's events, with the Convex variables `POSTHOG_PROJECT_ID`,
// `POSTHOG_PERSONAL_API_KEY`, and optional `POSTHOG_API_HOST`
// (component-repository §Configuration). It runs apart from the purge and the
// Clerk deletion, and neither waits for it. The distinct ID is the Clerk user
// ID the deletion record keeps, because the `users` row and the Clerk user can
// be gone by the time an attempt runs. Each attempt carries a number; an
// outcome for any attempt but the record's current one is ignored, so a late
// or duplicate attempt cannot move the retry schedule.

export const POSTHOG_DEFAULT_API_HOST = "https://us.posthog.com";

// What one attempt observed. `retryAfterMs` comes from a Retry-After header.
const outcomeValidator = v.union(
  v.object({ kind: v.literal("deleted") }),
  v.object({
    kind: v.literal("failed"),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  }),
);

type Outcome = { kind: "deleted" } | { kind: "failed"; error: string; retryAfterMs?: number };

// The distinct ID for the attempt, or null when the attempt is stale, the step
// is done, or the record has no PostHog step.
export const posthogTarget = internalQuery({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { deletionId, attempt }) => {
    const record = await ctx.db.get("accountDeletions", deletionId);
    if (
      record === null ||
      record.posthog?.state !== "pending" ||
      record.posthog.attempt !== attempt
    ) {
      return null;
    }
    return record.clerkUserId;
  },
});

// Reads a Retry-After header in seconds or as an HTTP date, as the Clerk
// deletion does.
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// Whether a parsed 2xx body names any deletion error. A null, an empty list,
// an empty object, and an empty string each count as no errors.
function namesDeletionErrors(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("deletion_errors" in body)) {
    return false;
  }
  const errors = body.deletion_errors;
  if (errors === null || errors === undefined || errors === "") {
    return false;
  }
  if (Array.isArray(errors)) {
    return errors.length > 0;
  }
  return typeof errors !== "object" || Object.keys(errors).length > 0;
}

// Classifies a response. The body is read here and goes no further, so the
// outcome holds only a short code. An empty 2xx body has no deletion errors and
// completes the step. A 2xx body that cannot be read or parsed retries, because
// it may hide deletion errors. A 404 is not a completion case: the step ends
// with a 2xx, including one whose `persons_found` is 0.
async function classify(response: Response): Promise<Outcome> {
  if (!response.ok) {
    const wait = retryAfterMs(response.headers.get("Retry-After"), Date.now());
    return {
      kind: "failed",
      error: `http_${response.status}`,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    };
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    return { kind: "failed", error: "unreadable_response" };
  }
  return namesDeletionErrors(body)
    ? { kind: "failed", error: "deletion_errors" }
    : { kind: "deleted" };
}

// One attempt. Without a project ID or a personal API key it logs
// `posthog_not_configured` and completes the step with no request, so a
// deployment without analytics deletes accounts normally. Any other status, a
// non-empty `deletion_errors`, and a network failure each record a short failure
// code and retry later; the response body and the key are never stored or
// logged.
export const deletePostHogPerson = internalAction({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { deletionId, attempt }) => {
    const distinctId = await ctx.runQuery(identity.posthogDeletion.posthogTarget, {
      deletionId,
      attempt,
    });
    if (distinctId === null) {
      return null;
    }
    const projectId = process.env.POSTHOG_PROJECT_ID;
    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    let outcome: Outcome;
    if (!projectId || !apiKey) {
      console.warn(`posthog_not_configured for account deletion ${deletionId}`);
      outcome = { kind: "deleted" };
    } else {
      const host = (process.env.POSTHOG_API_HOST || POSTHOG_DEFAULT_API_HOST).replace(/\/+$/, "");
      try {
        const response = await fetch(
          `${host}/api/projects/${encodeURIComponent(projectId)}/persons/bulk_delete/`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ distinct_ids: [distinctId], delete_events: true }),
          },
        );
        outcome = await classify(response);
      } catch {
        outcome = { kind: "failed", error: "network" };
      }
    }
    await ctx.runMutation(identity.posthogDeletion.recordPostHogOutcome, {
      deletionId,
      attempt,
      outcome,
    });
    return null;
  },
});

// Records an attempt's outcome. It leaves `updatedAt`, which tracks the purge,
// unchanged; recovery reads `nextAttemptAt` for this step. A failure schedules
// the next attempt after an exponential delay, or after Retry-After when
// PostHog asks for longer, and logs the failure code with the deletion id only.
export const recordPostHogOutcome = internalMutation({
  args: { deletionId: v.id("accountDeletions"), attempt: v.number(), outcome: outcomeValidator },
  returns: v.null(),
  handler: async (ctx, { deletionId, attempt, outcome }) => {
    const record = await ctx.db.get("accountDeletions", deletionId);
    if (
      record === null ||
      record.posthog?.state !== "pending" ||
      record.posthog.attempt !== attempt
    ) {
      return null;
    }
    const now = Date.now();
    if (outcome.kind === "deleted") {
      const posthog = {
        state: "done" as const,
        attempt,
        nextAttemptAt: record.posthog.nextAttemptAt,
        doneAt: now,
      };
      const refuseUntil = refusalEnd({ ...record, posthog });
      await ctx.db.patch("accountDeletions", deletionId, {
        posthog,
        ...(refuseUntil === undefined ? {} : { refuseUntil }),
      });
      return null;
    }
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const delay = Math.max(backoff, outcome.retryAfterMs ?? 0);
    const next = attempt + 1;
    console.error(
      `PostHog person deletion for account deletion ${deletionId} failed (${outcome.error}),` +
        ` attempt ${attempt}; retrying in ${Math.round(delay / 1000)} s`,
    );
    await ctx.db.patch("accountDeletions", deletionId, {
      posthog: {
        state: "pending",
        attempt: next,
        nextAttemptAt: now + delay,
        lastError: outcome.error,
      },
    });
    await ctx.scheduler.runAfter(delay, identity.posthogDeletion.deletePostHogPerson, {
      deletionId,
      attempt: next,
    });
    return null;
  },
});
