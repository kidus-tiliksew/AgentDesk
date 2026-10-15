// component-resume §Waiter: an incremental `text/event-stream` parser for the
// answer of `POST /device/wait` (component-gateway §Waiter endpoint). The
// gateway sends `: keepalive` comments, then one `message` event, then ends the
// stream. Chunks can split anywhere, including inside a UTF-8 sequence or
// between the CR and LF of a line ending.

export interface SseEvent {
  /** The `event` field, or `message` when the event names none. */
  event: string;
  /** The `data` lines joined with LF. */
  data: string;
}

/** Bytes kept for one unfinished event; a longer event is a protocol error. */
export const MAX_EVENT_BYTES = 1024 * 1024;

export class SseTooLargeError extends Error {
  constructor() {
    super("the event stream sent an event larger than the waiter accepts");
    this.name = "SseTooLargeError";
  }
}

/**
 * Feeds byte chunks and returns each event the chunk completes. An event is
 * complete at its blank line; data left without one when the stream ends is
 * not an event.
 */
export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  /** A CR ended the previous chunk, so a leading LF belongs to that line ending. */
  private pendingCr = false;
  private eventType = "";
  private dataLines: string[] = [];
  private eventBytes = 0;

  push(chunk: Uint8Array): SseEvent[] {
    return this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes the decoder at the end of the stream. A partial event is dropped. */
  end(): SseEvent[] {
    const events = this.consume(this.decoder.decode());
    this.buffer = "";
    this.eventType = "";
    this.dataLines = [];
    return events;
  }

  private consume(text: string): SseEvent[] {
    let input = text;
    if (this.pendingCr && input.startsWith("\n")) input = input.slice(1);
    this.pendingCr = false;
    this.buffer += input;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A CR at the very end may be the first half of CRLF split across chunks.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        this.pendingCr = true;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    if (this.buffer.length + this.eventBytes > MAX_EVENT_BYTES) throw new SseTooLargeError();
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line.length === 0) {
      const hasData = this.dataLines.length > 0;
      const event = { event: this.eventType || "message", data: this.dataLines.join("\n") };
      this.eventType = "";
      this.dataLines = [];
      this.eventBytes = 0;
      return hasData ? event : undefined;
    }
    this.eventBytes += line.length;
    if (this.eventBytes > MAX_EVENT_BYTES) throw new SseTooLargeError();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventType = value;
    else if (field === "data") this.dataLines.push(value);
    return undefined;
  }
}
