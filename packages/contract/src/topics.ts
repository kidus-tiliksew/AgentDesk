import { z } from "zod";

// component-contract §Topics; req-agent-tools REQ-8.
export const TOPIC_PATTERN = /^[a-z0-9._/-]{1,100}$/;

// A canonical topic, as stored and returned in read shapes. It carries no
// transform, so it converts to JSON Schema as a plain pattern.
export const topicSchema = z.string().regex(TOPIC_PATTERN);

// A topic as an agent or API caller supplies it: lowercased, then checked
// against the canonical pattern (req-agent-tools AC-8.1, AC-8.2).
export const topicInputSchema = z.string().toLowerCase().regex(TOPIC_PATTERN);

export function normalizeTopic(raw: unknown): z.ZodSafeParseResult<string> {
  return topicInputSchema.safeParse(raw);
}

// True when the topics are equal or `topic` lies under `ruleTopic`, so `a/b`
// matches `a/b/c` but not `a/bc`.
export function topicMatches(ruleTopic: string, topic: string): boolean {
  return topic === ruleTopic || topic.startsWith(`${ruleTopic}/`);
}
