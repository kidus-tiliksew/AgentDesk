import { notificationRoute } from "../src/notification-route";

// component-mobile-app §Notifications: the screen a tapped notification opens
// (req-mobile-app REQ-4).

describe("notification route", () => {
  test("a created decision opens its decision screen", () => {
    expect(
      notificationRoute({
        eventId: "ev_1",
        kind: "decision.created",
        decisionId: "jd7abc",
        agentSessionId: "ks9xyz",
      }),
    ).toEqual({ pathname: "/decision/[id]", params: { id: "jd7abc" } });
  });

  test("a stale agent opens its agent screen", () => {
    expect(
      notificationRoute({ eventId: "ev_2", kind: "agent.stale", agentSessionId: "ks9xyz" }),
    ).toEqual({ pathname: "/agent/[id]", params: { id: "ks9xyz" } });
  });

  test("an expired decision opens its decision screen", () => {
    expect(
      notificationRoute({
        eventId: "ev_3",
        kind: "decision.expired",
        decisionId: "jd7abc",
        agentSessionId: "ks9xyz",
      }),
    ).toEqual({ pathname: "/decision/[id]", params: { id: "jd7abc" } });
  });

  test.each(["agent.status_changed", "agent.done"])("%s opens its agent screen", (kind) => {
    expect(notificationRoute({ eventId: "ev_4", kind, agentSessionId: "ks9xyz" })).toEqual({
      pathname: "/agent/[id]",
      params: { id: "ks9xyz" },
    });
  });

  // Each kind added for the rules task falls back to the inbox on a missing,
  // wrong-type, empty, path, URL, or over-long id, as the first two kinds do.
  const malformedIds: [string, Record<string, unknown>][] = [
    ["a missing id", {}],
    ["a numeric id", { id: 42 }],
    ["an empty id", { id: "" }],
    ["a path in the id", { id: "../settings/account" }],
    ["a URL in the id", { id: "https://example.com" }],
    ["an over-long id", { id: "a".repeat(129) }],
  ];
  const addedKinds: [string, string, string][] = [
    ["decision.expired", "decisionId", "agentSessionId"],
    ["agent.status_changed", "agentSessionId", "decisionId"],
    ["agent.done", "agentSessionId", "decisionId"],
  ];
  test.each(
    addedKinds.flatMap(([kind, field, other]) =>
      malformedIds.map(([label, value]): [string, string, Record<string, unknown>] => [
        kind,
        label,
        {
          kind,
          // The other kind's id is well formed and must not be used.
          [other]: "jd7abc",
          ...("id" in value ? { [field]: value.id } : {}),
        },
      ]),
    ),
  )("%s with %s opens the inbox", (_kind, _label, data) => {
    expect(notificationRoute(data)).toBe("/");
  });

  test("a digest push opens the inbox", () => {
    expect(notificationRoute({ kind: "digest", digestId: "dg1abc" })).toBe("/");
  });

  test.each([
    ["no data", undefined],
    ["null", null],
    ["an array", ["decision.created"]],
    ["a string", "decision.created"],
    ["an unknown kind", { kind: "decision.answered", decisionId: "jd7abc" }],
    ["a non-string kind", { kind: 7, decisionId: "jd7abc" }],
    ["no kind", { decisionId: "jd7abc" }],
    ["a decision kind without its id", { kind: "decision.created", agentSessionId: "ks9xyz" }],
    ["an agent kind without its id", { kind: "agent.stale", decisionId: "jd7abc" }],
    ["an empty id", { kind: "decision.created", decisionId: "" }],
    ["a numeric id", { kind: "decision.created", decisionId: 42 }],
    ["a path in the id", { kind: "decision.created", decisionId: "../settings/account" }],
    ["a URL in the id", { kind: "agent.stale", agentSessionId: "https://example.com" }],
    ["an over-long id", { kind: "decision.created", decisionId: "a".repeat(129) }],
  ])("%s opens the inbox", (_label, data) => {
    expect(notificationRoute(data)).toBe("/");
  });
});
