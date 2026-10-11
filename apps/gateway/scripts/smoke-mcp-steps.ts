// component-gateway §Verification: the steps of the MCP smoke run. The module
// uses only web-platform globals, so the Workers-runtime tests drive it with a
// fake gateway, and `smoke-mcp.ts` adds the Node process, environment, and the
// Convex answer helper.

export const PROTOCOL_VERSION = "2025-11-25";
export const TOOL_NAMES = ["ask", "await", "check", "cancel", "status"] as const;
export const SMOKE_TOPIC = "smoke/mcp";
export const SMOKE_NOTE = "Smoke answer";

// The gateway writes `: keepalive` every 15 seconds (component-gateway §MCP
// transport). A gap of up to two intervals between consecutive arrivals,
// counting from the stream's opening and up to its final message, tolerates
// network jitter; a stream that a proxy buffers until settlement shows one gap
// as long as the whole wait and fails.
export const MAX_KEEPALIVE_GAP_MS = 30_000;
// req-agent-tools AC-3.1: `await` returns within 30 seconds of a settlement.
export const MAX_SETTLE_LATENCY_MS = 30_000;
// The default leg's deadline, measured from just before `ask`, and its wait
// limit.
export const DEFAULT_LEG_DEADLINE_MS = 300_000;
export const DEFAULT_LEG_TIMEOUT_SECONDS = 330;
// The default leg's `await` must return no earlier than the deadline, read on
// this machine's clock, less this allowance for skew against the deployment's
// clock. An `await` that returns sooner did not span the five-minute wait.
export const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type Step =
  | "initialize"
  | "tools/list"
  | "status"
  | "answered: ask"
  | "answered: await"
  | "answered: answer helper"
  | "default: ask"
  | "default: await";

// A mismatch or transport failure, named by the step it happened in.
export class SmokeError extends Error {
  constructor(
    readonly step: Step,
    message: string,
  ) {
    super(message);
  }
}

export interface Clock {
  // Epoch milliseconds.
  now(): number;
}

export interface ClientOptions {
  // The gateway origin, such as `http://localhost:8787`; `/mcp` is appended.
  url: string;
  token: string;
  fetch: typeof fetch;
  clock: Clock;
  // Aborts every request in flight, such as on Ctrl-C.
  signal?: AbortSignal;
  // Bound on a JSON request, and the extra time an `await` stream may run past
  // its own wait limit.
  requestTimeoutMs?: number;
}

// One `text/event-stream` comment or event, stamped when the chunk that
// completed it arrived.
export interface Comment {
  at: number;
  text: string;
}
export interface SseEvent {
  at: number;
  event: string;
  data: string;
}

export interface StreamRead {
  comments: Comment[];
  events: SseEvent[];
  // Whether the body ended mid-line or mid-event.
  truncated: boolean;
}

// Reads an event stream to its end, parsing incrementally across arbitrary
// byte boundaries, including inside a UTF-8 sequence or a CRLF pair. `signal`
// cancels the read.
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  clock: Clock,
  signal?: AbortSignal,
): Promise<StreamRead> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const comments: Comment[] = [];
  const events: SseEvent[] = [];
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let inEvent = false;

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const chunk = await reader.read();
      if (signal?.aborted) {
        throw signal.reason;
      }
      const at = clock.now();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        // A trailing CR may be the first half of a CRLF still to arrive.
        if (
          match === null ||
          (match[0] === "\r" && match.index === buffer.length - 1 && !chunk.done)
        ) {
          break;
        }
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          if (data.length > 0) {
            events.push({ at, event: event || "message", data: data.join("\n") });
          }
          event = "";
          data = [];
          inEvent = false;
          continue;
        }
        if (line.startsWith(":")) {
          comments.push({ at, text: line });
          continue;
        }
        inEvent = true;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        if (field === "event") {
          event = value;
        } else if (field === "data") {
          data.push(value);
        }
      }
      if (chunk.done) {
        return { comments, events, truncated: buffer !== "" || inEvent };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export interface KeepaliveEvidence {
  elapsedMs: number;
  comments: number;
  // Offsets from the stream's opening, or null without comments.
  firstAtMs: number | null;
  lastAtMs: number | null;
  maxGapMs: number;
}

// Measures keepalive arrivals over a wait from `openedAt` to `endedAt`. Gaps
// count from the opening to the first comment, between comments, and from the
// last comment to the end.
export function keepaliveEvidence(
  openedAt: number,
  comments: readonly Comment[],
  endedAt: number,
): KeepaliveEvidence {
  const times = comments.map((comment) => comment.at);
  let previous = openedAt;
  let maxGapMs = 0;
  for (const at of [...times, endedAt]) {
    maxGapMs = Math.max(maxGapMs, at - previous);
    previous = at;
  }
  const first = times[0];
  const last = times[times.length - 1];
  return {
    elapsedMs: endedAt - openedAt,
    comments: times.length,
    firstAtMs: first === undefined ? null : first - openedAt,
    lastAtMs: last === undefined ? null : last - openedAt,
    maxGapMs,
  };
}

type Json = Record<string, unknown>;

// A plain Streamable HTTP client for the gateway's MCP server.
export class McpClient {
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;

  constructor(private readonly options: ClientOptions) {
    this.endpoint = `${options.url.replace(/\/+$/, "")}/mcp`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get session(): string | null {
    return this.sessionId;
  }

  // Sends `initialize`, keeps the session id and negotiated version, and sends
  // `notifications/initialized`.
  async initialize(step: Step): Promise<{ protocolVersion: string; sessionId: string }> {
    const { response, id } = await this.post(step, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agentdesk-smoke", version: "0.0.0" },
    });
    const sessionId = response.headers.get("Mcp-Session-Id");
    const result = asObject(step, "initialize result", await this.result(step, response, id));
    if (sessionId === null || sessionId === "") {
      throw new SmokeError(step, "initialize returned no Mcp-Session-Id header");
    }
    if (typeof result.protocolVersion !== "string") {
      throw new SmokeError(step, "initialize result has no protocolVersion");
    }
    this.sessionId = sessionId;
    this.protocolVersion = result.protocolVersion;

    const notified = await this.send(step, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await notified.body?.cancel();
    if (notified.status !== 202) {
      throw new SmokeError(step, `notifications/initialized returned HTTP ${notified.status}`);
    }
    return { protocolVersion: result.protocolVersion, sessionId };
  }

  async listTools(step: Step): Promise<string[]> {
    const { response, id } = await this.post(step, "tools/list", {});
    const result = asObject(step, "tools/list result", await this.result(step, response, id));
    if (!Array.isArray(result.tools)) {
      throw new SmokeError(step, "tools/list result has no tools array");
    }
    return result.tools.map((tool: unknown) => {
      const name = asObject(step, "tool", tool).name;
      if (typeof name !== "string") {
        throw new SmokeError(step, "a listed tool has no name");
      }
      return name;
    });
  }

  // Calls a tool answered with JSON and decodes its text content as JSON.
  async callTool(step: Step, name: string, args: Json): Promise<Json> {
    const { response, id } = await this.post(step, "tools/call", { name, arguments: args });
    return toolJson(step, await this.result(step, response, id));
  }

  // Opens an `await` stream. Once the gateway answers with the stream's
  // headers, `opened` runs while the stream is read, so a settlement it causes
  // happens during the wait. The first of the two to fail aborts the signal
  // passed to `opened` and cancels the read, and the call returns once both
  // have settled, so no work outlives it. Returns the decoded tool result,
  // every comment, and the times the stream opened and its message arrived.
  async awaitDecision(
    step: Step,
    args: { decision_id: string; timeout_seconds: number },
    opened: (signal: AbortSignal) => Promise<void> = async () => {},
  ): Promise<{ result: Json; comments: Comment[]; openedAt: number; messageAt: number }> {
    const limitMs = args.timeout_seconds * 1000 + this.requestTimeoutMs;
    const { response, id, signal } = await this.post(
      step,
      "tools/call",
      { name: "await", arguments: args },
      limitMs,
    );
    const openedAt = this.options.clock.now();
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new SmokeError(step, `await returned HTTP ${response.status}`);
    }
    if (mediaType(response) !== "text/event-stream") {
      await response.body?.cancel();
      throw new SmokeError(
        step,
        `await answered ${mediaType(response) || "no content type"}, not text/event-stream`,
      );
    }
    if (response.body === null) {
      throw new SmokeError(step, "await answered without a body");
    }
    // The request's own bound and interruption also stop the read, whatever
    // the fetch implementation does with its body.
    const stop = new AbortController();
    const linked = AbortSignal.any([signal, stop.signal]);
    let first: { from: "read" | "opened"; error: unknown } | undefined;
    const failFast = <T>(from: "read" | "opened", promise: Promise<T>) =>
      promise.catch((error: unknown) => {
        if (first === undefined) {
          first = { from, error };
          stop.abort(error);
        }
        throw error;
      });
    const [read] = await Promise.allSettled([
      failFast("read", readEventStream(response.body, this.options.clock, linked)),
      failFast("opened", opened(linked)),
    ]);
    if (first !== undefined) {
      if (first.from === "opened") {
        throw first.error;
      }
      throw new SmokeError(step, `await stream failed: ${describe(first.error)}`);
    }
    if (read.status !== "fulfilled") {
      throw new SmokeError(step, "await stream failed");
    }
    const message = this.streamMessage(step, read.value, id);
    return {
      result: toolJson(step, message.result),
      comments: read.value.comments,
      openedAt,
      messageAt: message.at,
    };
  }

  // The stream's single `message` event, checked as the response to `id`.
  private streamMessage(step: Step, read: StreamRead, id: number): { result: unknown; at: number } {
    if (read.truncated) {
      throw new SmokeError(step, "event stream ended mid-event");
    }
    const messages = read.events.filter((event) => event.event === "message");
    if (messages.length !== 1 || read.events.length !== 1) {
      throw new SmokeError(
        step,
        `event stream carried ${messages.length} message events, expected 1`,
      );
    }
    const message = messages[0] as SseEvent;
    return { result: rpcResult(step, parseJson(step, message.data), id), at: message.at };
  }

  // The JSON-RPC result of a non-await request, answered as JSON or as a
  // stream.
  private async result(step: Step, response: Response, id: number): Promise<unknown> {
    if (response.status !== 200) {
      const text = await response.text().catch(() => "");
      throw new SmokeError(step, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const type = mediaType(response);
    if (type === "application/json") {
      return rpcResult(step, parseJson(step, await response.text()), id);
    }
    if (type === "text/event-stream" && response.body !== null) {
      return this.streamMessage(step, await readEventStream(response.body, this.options.clock), id)
        .result;
    }
    await response.body?.cancel();
    throw new SmokeError(step, `unexpected content type ${type || "(none)"}`);
  }

  private async post(
    step: Step,
    method: string,
    params: Json,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<{ response: Response; id: number; signal: AbortSignal }> {
    const id = this.nextId++;
    const signal = this.signal(timeoutMs);
    const response = await this.send(step, { jsonrpc: "2.0", id, method, params }, signal);
    return { response, id, signal };
  }

  // Aborts after `timeoutMs` or when the run is interrupted.
  private signal(timeoutMs: number): AbortSignal {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.options.signal !== undefined) {
      signals.push(this.options.signal);
    }
    return AbortSignal.any(signals);
  }

  // Sends one message with the credential, the session, and the negotiated
  // version. `signal` bounds the whole exchange, including reading a body.
  private async send(
    step: Step,
    body: Json,
    signal = this.signal(this.requestTimeoutMs),
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    if (this.protocolVersion !== null) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }
    try {
      return await this.options.fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new SmokeError(step, `request failed: ${describe(error)}`);
    }
  }
}

function mediaType(response: Response): string {
  return response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function parseJson(step: Step, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeError(step, `malformed JSON: ${text.slice(0, 200)}`);
  }
}

function asObject(step: Step, what: string, value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeError(step, `${what} is not an object`);
  }
  return value as Json;
}

// Checks a JSON-RPC response to `id` and returns its result.
function rpcResult(step: Step, message: unknown, id: number): unknown {
  const body = asObject(step, "JSON-RPC response", message);
  if (body.jsonrpc !== "2.0" || body.id !== id) {
    throw new SmokeError(
      step,
      `JSON-RPC response id ${JSON.stringify(body.id)} does not match ${id}`,
    );
  }
  if ("error" in body) {
    throw new SmokeError(step, `JSON-RPC error ${JSON.stringify(body.error)}`);
  }
  if (!("result" in body)) {
    throw new SmokeError(step, "JSON-RPC response has no result");
  }
  return body.result;
}

// Decodes a tool result's first text content as JSON. A result with
// `isError: true` is a failure.
function toolJson(step: Step, result: unknown): Json {
  const body = asObject(step, "tool result", result);
  const first = Array.isArray(body.content) ? body.content[0] : undefined;
  const text = asObject(step, "tool content", first).text;
  if (typeof text !== "string") {
    throw new SmokeError(step, "tool result has no text content");
  }
  if (body.isError !== false) {
    throw new SmokeError(step, `tool error: ${text.slice(0, 300)}`);
  }
  return asObject(step, "tool result JSON", parseJson(step, text));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function expectEqual(step: Step, field: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SmokeError(
      step,
      `${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

// Settles a decision on the dev deployment, as the Convex dev answer helper
// does (`decisions/devAnswer:answer`). It stops its work and settles once
// `signal` aborts.
export type AnswerHelper = (
  args: {
    decisionId: string;
    answer: { kind: "approve" };
    note: string;
    answeredVia: "app";
  },
  signal: AbortSignal,
) => Promise<void>;

export interface SmokeOptions {
  client: McpClient;
  answer: AnswerHelper;
  clock: Clock;
  // Fresh per run, so `ask` idempotency keys never replay an earlier run.
  runId: string;
  // Skips the five-minute default leg.
  quick: boolean;
  log: (line: string) => void;
}

export interface SmokeReport {
  sessionId: string;
  answered: { decisionId: string; settleLatencyMs: number };
  defaulted: { decisionId: string; keepalive: KeepaliveEvidence } | null;
}

// Runs every step in order and throws a SmokeError at the first mismatch.
export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const { client, log } = options;

  const init = await client.initialize("initialize");
  log(`ok initialize: protocol ${init.protocolVersion}, Mcp-Session-Id received`);

  const tools = await client.listTools("tools/list");
  expectEqual("tools/list", "tool names", [...tools].sort(), [...TOOL_NAMES].sort());
  log(`ok tools/list: ${tools.join(", ")}`);

  const session = await client.callTool("status", "status", {
    topic: SMOKE_TOPIC,
    state: "working",
    line: `Smoke run ${options.runId}`,
  });
  expectEqual("status", "state", session.state, "working");
  log("ok status: working");

  const answered = await answeredLeg(options);
  log(
    `ok answered leg: ${answered.decisionId} answered ${answered.settleLatencyMs} ms after the helper returned`,
  );

  if (options.quick) {
    log("skipped default leg (--quick): the five-minute keepalive wait is unverified");
    return { sessionId: init.sessionId, answered, defaulted: null };
  }
  const defaulted = await defaultLeg(options);
  const k = defaulted.keepalive;
  log(
    `ok default leg: ${defaulted.decisionId} expired with the default after ${k.elapsedMs} ms; ` +
      `${k.comments} keepalives, first at ${k.firstAtMs} ms, last at ${k.lastAtMs} ms, ` +
      `largest gap ${k.maxGapMs} ms`,
  );
  return { sessionId: init.sessionId, answered, defaulted };
}

// `ask` with no deadline, then `await`, answered through the helper once the
// stream is open.
async function answeredLeg(
  options: SmokeOptions,
): Promise<{ decisionId: string; settleLatencyMs: number }> {
  const { client, clock } = options;
  const decisionId = await ask(options, "answered: ask", {
    title: "Smoke: approve this decision",
    input_type: "approve_reject",
    topic: SMOKE_TOPIC,
    idempotency_key: `smoke-${options.runId}-answered`,
  });

  let answeredAt = 0;
  const waited = await client.awaitDecision(
    "answered: await",
    { decision_id: decisionId, timeout_seconds: 120 },
    async (signal) => {
      try {
        await options.answer(
          { decisionId, answer: { kind: "approve" }, note: SMOKE_NOTE, answeredVia: "app" },
          signal,
        );
      } catch (error) {
        throw new SmokeError("answered: answer helper", describe(error));
      }
      answeredAt = clock.now();
    },
  );
  const step = "answered: await";
  expectEqual(step, "decision id", waited.result.id, decisionId);
  expectEqual(step, "state", waited.result.state, "answered");
  expectEqual(step, "answer", waited.result.answer, { kind: "approve" });
  expectEqual(step, "note", waited.result.note, SMOKE_NOTE);
  expectEqual(step, "applied_by_default", waited.result.applied_by_default, false);
  const settleLatencyMs = waited.messageAt - answeredAt;
  if (settleLatencyMs > MAX_SETTLE_LATENCY_MS) {
    throw new SmokeError(
      step,
      `await returned ${settleLatencyMs} ms after the answer, more than ${MAX_SETTLE_LATENCY_MS} ms`,
    );
  }
  return { decisionId, settleLatencyMs };
}

// `ask` with a five-minute deadline and a default, then one `await` that
// outlasts the deadline. Nothing answers it.
async function defaultLeg(
  options: SmokeOptions,
): Promise<{ decisionId: string; keepalive: KeepaliveEvidence }> {
  const { client, clock } = options;
  const deadlineMs = clock.now() + DEFAULT_LEG_DEADLINE_MS;
  const deadline = new Date(deadlineMs).toISOString();
  const decisionId = await ask(options, "default: ask", {
    title: "Smoke: let this decision expire",
    input_type: "approve_reject",
    topic: SMOKE_TOPIC,
    deadline,
    default: { kind: "reject" },
    idempotency_key: `smoke-${options.runId}-default`,
  });

  const waited = await client.awaitDecision("default: await", {
    decision_id: decisionId,
    timeout_seconds: DEFAULT_LEG_TIMEOUT_SECONDS,
  });
  const step = "default: await";
  const keepalive = keepaliveEvidence(waited.openedAt, waited.comments, waited.messageAt);
  if (waited.result.state === "pending") {
    throw new SmokeError(
      step,
      `still pending when the ${DEFAULT_LEG_TIMEOUT_SECONDS}-second limit elapsed, ` +
        `${keepalive.elapsedMs} ms after the stream opened; deadline was ${deadline}`,
    );
  }
  expectEqual(step, "decision id", waited.result.id, decisionId);
  expectEqual(step, "state", waited.result.state, "expired");
  expectEqual(step, "answer", waited.result.answer, { kind: "reject" });
  expectEqual(step, "applied_by_default", waited.result.applied_by_default, true);
  expectEqual(step, "answered_via", waited.result.answered_via, "default");
  // The deployment expired the decision at its deadline, not before
  // (req-decision-requests AC-5.1), and the stream stayed open until then.
  expectEqual(step, "deadline", parseInstant(waited.result.deadline), deadlineMs);
  const expiredAt = parseInstant(waited.result.answered_at);
  if (expiredAt === null || expiredAt < deadlineMs) {
    throw new SmokeError(
      step,
      `answered_at ${JSON.stringify(waited.result.answered_at)} is before the deadline ${deadline}`,
    );
  }
  if (waited.messageAt < deadlineMs - CLOCK_SKEW_TOLERANCE_MS) {
    throw new SmokeError(
      step,
      `await returned ${deadlineMs - waited.messageAt} ms before the deadline ${deadline}, ` +
        `more than the ${CLOCK_SKEW_TOLERANCE_MS} ms clock tolerance; the five-minute wait was not exercised`,
    );
  }
  if (keepalive.comments === 0 || keepalive.maxGapMs > MAX_KEEPALIVE_GAP_MS) {
    throw new SmokeError(
      step,
      `keepalives did not span the wait: ${keepalive.comments} comments, ` +
        `largest gap ${keepalive.maxGapMs} ms, allowed ${MAX_KEEPALIVE_GAP_MS} ms`,
    );
  }
  return { decisionId, keepalive };
}

// Epoch milliseconds of an ISO 8601 instant, or null.
function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

async function ask(options: SmokeOptions, step: Step, args: Json): Promise<string> {
  const created = await options.client.callTool(step, "ask", args);
  expectEqual(step, "state", created.state, "pending");
  if (typeof created.decision_id !== "string" || created.decision_id === "") {
    throw new SmokeError(step, "ask returned no decision_id");
  }
  return created.decision_id;
}
