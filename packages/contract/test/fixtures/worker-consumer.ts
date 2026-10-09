// A representative gateway handler: it imports the contract by package name
// and validates the status tool's arguments, composing the topic itself
// (component-gateway §Tools).
import { normalizeTopic, statusInputSchema, topicMatches } from "@agentdesk/contract";

export function status(args: { topic?: unknown } & Record<string, unknown>): string {
  const topic = normalizeTopic(args.topic);
  if (!topic.success) return "invalid: topic";
  const input = statusInputSchema.safeParse(args);
  if (!input.success) return `invalid: ${input.error.issues[0]?.path.join(".")}`;
  return topicMatches("repo", topic.data) ? `ok: ${input.data.state}` : "ok: other";
}
