import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, SseParser, SseTooLargeError } from "../../src/resume/sse.js";

// component-resume §Waiter: the waiter reads the `text/event-stream` answer of
// `POST /device/wait` (component-gateway §Waiter endpoint) incrementally.

const encoder = new TextEncoder();

function parseInChunks(text: string, size: number) {
  const parser = new SseParser();
  const bytes = encoder.encode(text);
  const events = [];
  for (let i = 0; i < bytes.length; i += size)
    events.push(...parser.push(bytes.slice(i, i + size)));
  events.push(...parser.end());
  return events;
}

const STREAM =
  ': keepalive\n\n: keepalive\n\nevent: message\ndata: {"decision":{"id":"dec_1","title":"Café ☕ déploiement"}}\n\n';

describe("SseParser", () => {
  it("skips keepalive comments and returns the message event", () => {
    expect(parseInChunks(STREAM, STREAM.length)).toEqual([
      {
        event: "message",
        data: '{"decision":{"id":"dec_1","title":"Café ☕ déploiement"}}',
      },
    ]);
  });

  it("returns the same event however the bytes are split, including inside UTF-8 sequences", () => {
    const expected = parseInChunks(STREAM, 1_000_000);
    for (const size of [1, 2, 3, 5, 7, 13]) expect(parseInChunks(STREAM, size)).toEqual(expected);
  });

  it("accepts CRLF and CR line endings, with CRLF split across chunks", () => {
    const crlf = STREAM.replaceAll("\n", "\r\n");
    const cr = STREAM.replaceAll("\n", "\r");
    const expected = parseInChunks(STREAM, 1_000_000);
    for (const size of [1, 2, 4]) {
      expect(parseInChunks(crlf, size)).toEqual(expected);
      expect(parseInChunks(cr, size)).toEqual(expected);
    }
  });

  it("joins data lines, defaults the event name, and ignores unknown fields", () => {
    expect(parseInChunks("id: 1\nretry: 5\ndata: a\ndata:b\n\n", 3)).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("drops an event left without its blank line when the stream ends", () => {
    expect(parseInChunks(': keepalive\n\nevent: message\ndata: {"decision":', 4)).toEqual([]);
  });

  it("refuses an event larger than the waiter accepts", () => {
    const parser = new SseParser();
    const big = encoder.encode(`data: ${"x".repeat(MAX_EVENT_BYTES + 10)}`);
    expect(() => parser.push(big)).toThrow(SseTooLargeError);
  });
});
