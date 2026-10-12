// component-mobile-app §Notifications: the screen a tapped notification opens
// (req-mobile-app REQ-4). component-notifications puts `kind`, `eventId`, and
// the event's `decisionId` or `agentSessionId` in each event push's data, and
// `{ kind: "digest", digestId }` in a digest push's data. The app maps an
// allowlisted kind and a well-formed id to a typed route and never follows a
// path or URL from the payload. The opened screen's own query checks that the
// record exists and belongs to the person.

export type NotificationRoute =
  | { pathname: "/decision/[id]"; params: { id: string } }
  | { pathname: "/agent/[id]"; params: { id: string } }
  | { pathname: "/digest/[id]"; params: { id: string } }
  | "/";

// Convex document ids are short URL-safe strings.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Whether a value is a well-formed record id: 1 to 128 letters, digits, `_`,
// or `-`.
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function idField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return isRecordId(value) ? value : null;
}

// The pushable kinds that open a decision and those that open an agent. The
// digest kind opens the digest screen.
const DECISION_KINDS: ReadonlySet<string> = new Set(["decision.created", "decision.expired"]);
const AGENT_KINDS: ReadonlySet<string> = new Set([
  "agent.stale",
  "agent.status_changed",
  "agent.done",
]);
const DIGEST_KIND = "digest";

// Missing, malformed, or unknown data opens the inbox.
export function notificationRoute(data: unknown): NotificationRoute {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "/";
  }
  const fields = data as Record<string, unknown>;
  if (typeof fields.kind !== "string") {
    return "/";
  }
  if (DECISION_KINDS.has(fields.kind)) {
    const id = idField(fields, "decisionId");
    return id === null ? "/" : { pathname: "/decision/[id]", params: { id } };
  }
  if (AGENT_KINDS.has(fields.kind)) {
    const id = idField(fields, "agentSessionId");
    return id === null ? "/" : { pathname: "/agent/[id]", params: { id } };
  }
  if (fields.kind === DIGEST_KIND) {
    const id = idField(fields, "digestId");
    return id === null ? "/" : { pathname: "/digest/[id]", params: { id } };
  }
  return "/";
}
