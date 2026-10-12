import { errorCodeSchema } from "@agentdesk/contract";
import { decisions } from "../../../convex/decisions/refs";
import { answerFailure } from "./decision-errors";
import type { ActionRequest, SendResult } from "./notification-actions";
import { errorData } from "./query-error-boundary";

// component-mobile-app §Notifications: the answer from an action button, sent
// as the signed-in person without the React tree. The session comes from the
// Clerk singleton that ClerkProvider also uses (`getClerkInstance` with the
// same publishable key and `@clerk/expo/token-cache`), loaded from the stored
// client token when the app starts in the background. Each answer takes a
// fresh session token, which the Clerk Convex integration issues with
// `aud: "convex"`, and sends it through an action-scoped Convex HTTP client.
// The backend maps the action to the answer and records the surface as
// `notification` (component-decisions §App functions).

export type HeadlessSession = {
  id: string;
  getToken(options: { skipCache: boolean }): Promise<string | null>;
};

export type HeadlessClerk = {
  loaded: boolean;
  session: HeadlessSession | null | undefined;
  load(options: {
    standardBrowser: false;
    experimental: { runtimeEnvironment: "headless" };
  }): Promise<unknown>;
};

export type AnswerArgs = { decisionId: string; action: string };

export type AnswerClient = {
  setAuth(token: string): void;
  mutation(
    reference: typeof decisions.app.answerFromNotification,
    args: AnswerArgs,
  ): Promise<unknown>;
};

export type AuthDeps = {
  // The Clerk singleton. It throws when the app is not configured.
  clerk(): HeadlessClerk;
  // A new Convex HTTP client for one answer.
  client(): AnswerClient;
};

// The options ClerkProvider loads Clerk with on a native platform.
const LOAD_OPTIONS = {
  standardBrowser: false,
  experimental: { runtimeEnvironment: "headless" },
} as const;

// A Clerk API refusal that means the session is gone rather than
// unreachable.
function sessionGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  return error.status === 401 || error.status === 404;
}

function mutationResult(error: unknown): SendResult {
  if (errorData(error)?.code === errorCodeSchema.enum.unauthenticated) {
    return { kind: "sign-in" };
  }
  const failure = answerFailure(error);
  return failure.kind === "conflict"
    ? { kind: "conflict", decision: failure.decision }
    : { kind: "failed" };
}

// Returns the sender of action answers. Concurrent answers share one Clerk
// load. The active session's id is captured once and checked after every
// await and again immediately before the mutation, so an answer whose session
// ended or changed is never sent as another account; it is the sign-in
// outcome. Sign-out ends the Clerk session, so a press on a notification
// delivered before sign-out finds no session.
export function createAnswerSender(
  deps: AuthDeps,
): (request: ActionRequest, canSend: () => boolean) => Promise<SendResult> {
  let loading: Promise<void> | null = null;

  const ensureLoaded = async (clerk: HeadlessClerk) => {
    if (clerk.loaded) {
      return;
    }
    loading ??= clerk
      .load(LOAD_OPTIONS)
      .then(() => undefined)
      .finally(() => {
        loading = null;
      });
    await loading;
  };

  return async (request, canSend) => {
    let clerk: HeadlessClerk;
    try {
      clerk = deps.clerk();
      await ensureLoaded(clerk);
    } catch {
      return { kind: "failed" };
    }
    const session = clerk.session;
    if (session === null || session === undefined) {
      return { kind: "sign-in" };
    }
    const sessionId = session.id;
    const sameSession = () => clerk.session?.id === sessionId;

    let token: string | null;
    try {
      token = await session.getToken({ skipCache: true });
    } catch (error) {
      return !sameSession() || sessionGone(error) ? { kind: "sign-in" } : { kind: "failed" };
    }
    if (!sameSession() || token === null) {
      return { kind: "sign-in" };
    }

    let client: AnswerClient;
    try {
      client = deps.client();
      client.setAuth(token);
    } catch {
      return { kind: "failed" };
    }
    // Checked again immediately before the mutation goes out.
    if (!sameSession()) {
      return { kind: "sign-in" };
    }
    if (!canSend()) {
      return { kind: "failed" };
    }
    try {
      const decision = await client.mutation(decisions.app.answerFromNotification, {
        decisionId: request.decisionId,
        action: request.actionId,
      });
      return { kind: "answered", decision };
    } catch (error) {
      return mutationResult(error);
    }
  };
}
