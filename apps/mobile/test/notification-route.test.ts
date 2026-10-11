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

  test.each([
    ["no data", undefined],
    ["null", null],
    ["an array", ["decision.created"]],
    ["a string", "decision.created"],
    ["an unknown kind", { kind: "decision.expired", decisionId: "jd7abc" }],
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
