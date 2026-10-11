// component-mobile-app §Notifications: the screen a tapped notification opens
// (req-mobile-app REQ-4). component-notifications puts `kind`, `eventId`, and
// the event's `decisionId` or `agentSessionId` in each push's data. The app
// maps an allowlisted kind and a well-formed id to a typed route and never
// follows a path or URL from the payload. The opened screen's own query
// checks that the record exists and belongs to the person.

export type NotificationRoute =
  | { pathname: "/decision/[id]"; params: { id: string } }
  | { pathname: "/agent/[id]"; params: { id: string } }
  | "/";

// Convex document ids are short URL-safe strings.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function idField(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

// Missing, malformed, or unknown data opens the inbox.
export function notificationRoute(data: unknown): NotificationRoute {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "/";
  }
  const fields = data as Record<string, unknown>;
  if (fields.kind === "decision.created") {
    const id = idField(fields, "decisionId");
    return id === null ? "/" : { pathname: "/decision/[id]", params: { id } };
  }
  if (fields.kind === "agent.stale") {
    const id = idField(fields, "agentSessionId");
    return id === null ? "/" : { pathname: "/agent/[id]", params: { id } };
  }
  return "/";
}
