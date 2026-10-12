import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import {
  type AnswerArgs,
  type AnswerClient,
  createAnswerSender,
  type HeadlessClerk,
  type HeadlessSession,
} from "../src/notification-action-auth";
import type { ActionRequest } from "../src/notification-actions";
import { decision } from "./data";
import { deferred } from "./fakes";

// component-mobile-app §Notifications: the answer from an action button,
// sent as the signed-in person outside React. Clerk's singleton and the
// Convex HTTP client are fakes; no test renders a screen, so these also cover
// a cold background start with no React tree.

const request: ActionRequest = {
  requestId: "n_1",
  categoryId: "decision-approve-reject",
  actionId: "approve",
  decisionId: "d_1",
};

const answered = decision({ id: "d_1", state: "answered", answer: { kind: "approve" } });

function session(id: string, token: string | null = `jwt-${id}`) {
  return {
    id,
    getToken: jest.fn(async (_options: { skipCache: boolean }) => token),
  } satisfies HeadlessSession;
}

// A Clerk singleton that has not loaded yet, as on a cold start. Loading
// restores `restored` as the active session.
function coldClerk(restored: HeadlessSession | null) {
  const clerk = {
    loaded: false,
    session: undefined as HeadlessSession | null | undefined,
    load: jest.fn(async (_options: unknown) => {
      clerk.loaded = true;
      clerk.session = restored;
    }),
  };
  return clerk;
}

function fakeClient(result: () => Promise<unknown> = async () => answered) {
  const calls: { name: string; args: AnswerArgs; auth: string | null }[] = [];
  let auth: string | null = null;
  const client = {
    setAuth: jest.fn((token: string) => {
      auth = token;
    }),
    mutation: jest.fn(async (reference: unknown, args: AnswerArgs) => {
      calls.push({ name: getFunctionName(reference as never), args, auth });
      return result();
    }),
  };
  return { client: client as AnswerClient & typeof client, calls };
}

function sender(clerk: HeadlessClerk, client = fakeClient().client) {
  const deps = { clerk: jest.fn(() => clerk), client: jest.fn(() => client) };
  return { send: createAnswerSender(deps), deps };
}

const always = () => true;

test("a cold start loads Clerk headless, takes a fresh token, and sends the press", async () => {
  const active = session("sess_a");
  const clerk = coldClerk(active);
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  await expect(send(request, always)).resolves.toEqual({ kind: "answered", decision: answered });

  expect(clerk.load).toHaveBeenCalledTimes(1);
  expect(clerk.load).toHaveBeenCalledWith({
    standardBrowser: false,
    experimental: { runtimeEnvironment: "headless" },
  });
  expect(active.getToken).toHaveBeenCalledWith({ skipCache: true });
  expect(calls).toEqual([
    {
      name: "decisions/app:answerFromNotification",
      args: { decisionId: "d_1", action: "approve" },
      auth: "jwt-sess_a",
    },
  ]);
});

test.each(["approve", "reject", "option-1", "option-2", "option-3"] as const)(
  "sends the %s action id as it is, with no answer, surface, or user",
  async (actionId) => {
    const { client, calls } = fakeClient();
    const { send } = sender(coldClerk(session("sess_a")), client);
    await send({ ...request, actionId }, always);

    expect(calls[0]?.args).toEqual({ decisionId: "d_1", action: actionId });
  },
);

test("each answer uses a new client", async () => {
  const clerk = coldClerk(session("sess_a"));
  const { send, deps } = sender(clerk);
  await send(request, always);
  await send({ ...request, requestId: "n_2" }, always);

  expect(deps.client).toHaveBeenCalledTimes(2);
});

test("a loaded Clerk is not loaded again", async () => {
  const clerk = coldClerk(session("sess_a"));
  clerk.loaded = true;
  clerk.session = session("sess_a");
  const { send } = sender(clerk);
  await send(request, always);

  expect(clerk.load).not.toHaveBeenCalled();
});

test("concurrent presses share one Clerk load", async () => {
  const loading = deferred<undefined>();
  const clerk = coldClerk(session("sess_a"));
  clerk.load.mockImplementationOnce(async () => {
    await loading.promise;
    clerk.loaded = true;
    clerk.session = session("sess_a");
  });
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  const first = send(request, always);
  const second = send({ ...request, requestId: "n_2" }, always);
  loading.resolve(undefined);
  await Promise.all([first, second]);

  expect(clerk.load).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(2);
});

test("a failed Clerk load is a failure and sends nothing", async () => {
  const clerk = coldClerk(session("sess_a"));
  clerk.load.mockRejectedValueOnce(new Error("network"));
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  await expect(send(request, always)).resolves.toEqual({ kind: "failed" });
  expect(calls).toEqual([]);
});

test("an unconfigured app is a failure and sends nothing", async () => {
  const { client, calls } = fakeClient();
  const send = createAnswerSender({
    clerk: () => {
      throw new Error("AgentDesk is not configured");
    },
    client: () => client,
  });

  await expect(send(request, always)).resolves.toEqual({ kind: "failed" });
  expect(calls).toEqual([]);
});

test("no session after loading asks to sign in and sends nothing", async () => {
  const { client, calls } = fakeClient();
  const { send, deps } = sender(coldClerk(null), client);

  await expect(send(request, always)).resolves.toEqual({ kind: "sign-in" });
  expect(deps.client).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test("after sign-out ended the session, a delivered notification cannot answer as the old account", async () => {
  // Sign-out unregistered the device and ended the Clerk session; the stored
  // client token restores no active session.
  const clerk = coldClerk(session("sess_old"));
  clerk.loaded = true;
  clerk.session = null;
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  await expect(send(request, always)).resolves.toEqual({ kind: "sign-in" });
  expect(calls).toEqual([]);
});

test("a session that ends while the token is fetched sends nothing", async () => {
  const token = deferred<string | null>();
  const active = session("sess_a");
  active.getToken.mockImplementationOnce(() => token.promise);
  const clerk = coldClerk(active);
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  const result = send(request, always);
  await new Promise((resolve) => setImmediate(resolve));
  clerk.session = null;
  token.resolve("jwt-sess_a");

  await expect(result).resolves.toEqual({ kind: "sign-in" });
  expect(calls).toEqual([]);
});

test("a session that changes to another account before sending sends nothing", async () => {
  const token = deferred<string | null>();
  const active = session("sess_a");
  active.getToken.mockImplementationOnce(() => token.promise);
  const clerk = coldClerk(active);
  const { client, calls } = fakeClient();
  const { send } = sender(clerk, client);

  const result = send(request, always);
  await new Promise((resolve) => setImmediate(resolve));
  clerk.session = session("sess_b");
  token.resolve("jwt-sess_a");

  await expect(result).resolves.toEqual({ kind: "sign-in" });
  expect(calls).toEqual([]);
});

test("a session that ends while the client is made sends nothing", async () => {
  const clerk = coldClerk(session("sess_a"));
  const { client, calls } = fakeClient();
  const send = createAnswerSender({
    clerk: () => clerk,
    client: () => {
      clerk.session = null;
      return client;
    },
  });

  await expect(send(request, always)).resolves.toEqual({ kind: "sign-in" });
  expect(calls).toEqual([]);
});

test("no token asks to sign in", async () => {
  const { client, calls } = fakeClient();
  const { send } = sender(coldClerk(session("sess_a", null)), client);

  await expect(send(request, always)).resolves.toEqual({ kind: "sign-in" });
  expect(calls).toEqual([]);
});

test.each([401, 404])("a token refusal with status %i asks to sign in", async (status) => {
  const active = session("sess_a");
  active.getToken.mockRejectedValueOnce(Object.assign(new Error("refused"), { status }));
  const { send } = sender(coldClerk(active));

  await expect(send(request, always)).resolves.toEqual({ kind: "sign-in" });
});

test("a token request that fails on the network is a failure", async () => {
  const active = session("sess_a");
  active.getToken.mockRejectedValueOnce(new TypeError("Network request failed"));
  const { client, calls } = fakeClient();
  const { send } = sender(coldClerk(active), client);

  await expect(send(request, always)).resolves.toEqual({ kind: "failed" });
  expect(calls).toEqual([]);
});

test("a refused send check sends nothing", async () => {
  const { client, calls } = fakeClient();
  const { send } = sender(coldClerk(session("sess_a")), client);

  await expect(send(request, () => false)).resolves.toEqual({ kind: "failed" });
  expect(calls).toEqual([]);
});

describe("mutation refusals", () => {
  async function refusal(error: unknown) {
    const { client } = fakeClient(async () => {
      throw error;
    });
    const { send } = sender(coldClerk(session("sess_a")), client);
    return send(request, always);
  }

  test("unauthenticated asks to sign in", async () => {
    await expect(
      refusal(new ConvexError({ code: "unauthenticated", message: "Not signed in" })),
    ).resolves.toEqual({ kind: "sign-in" });
  });

  test("a conflict carries the stored decision", async () => {
    const stored = decision({ id: "d_1", state: "cancelled" });
    await expect(
      refusal(
        new ConvexError({
          code: "conflict",
          message: "Decision is already cancelled",
          decision: stored,
        }),
      ),
    ).resolves.toEqual({ kind: "conflict", decision: stored });
  });

  test("a conflict without a readable decision is a failure", async () => {
    await expect(
      refusal(new ConvexError({ code: "conflict", message: "Decision is already answered" })),
    ).resolves.toEqual({ kind: "failed" });
  });

  test.each([
    ["not_found", new ConvexError({ code: "not_found", message: "Decision not found" })],
    ["invalid", new ConvexError({ code: "invalid", message: "Invalid action", field: "action" })],
    ["a network error", new TypeError("Network request failed")],
  ])("%s is a failure", async (_name, error) => {
    await expect(refusal(error)).resolves.toEqual({ kind: "failed" });
  });
});
