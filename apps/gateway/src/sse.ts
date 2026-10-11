// component-gateway §MCP transport: the `text/event-stream` response that
// `await` answers with. A comment every 15 seconds keeps intermediaries from
// closing an idle connection; one `message` event carries the JSON-RPC
// response, and the stream ends.

export const KEEPALIVE_MS = 15_000;

const KEEPALIVE = ": keepalive\n\n";

// Returns the response at once and runs `produce` behind it. `produce` gets a
// signal that aborts when the client disconnects, through `request` or by
// cancelling the stream; after that nothing more is written. A rejection of
// `produce` ends the stream without a message.
export function eventStream(
  request: AbortSignal,
  produce: (signal: AbortSignal) => Promise<unknown>,
): Response {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let done = false;

  // The single terminal path: clears the timer and listener and aborts
  // `produce`. Every later call does nothing.
  const finish = () => {
    if (done) {
      return false;
    }
    done = true;
    if (keepalive !== undefined) {
      clearInterval(keepalive);
    }
    request.removeEventListener("abort", onDisconnect);
    stop.abort();
    return true;
  };
  let close = () => {};
  const onDisconnect = () => {
    if (finish()) {
      close();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        try {
          controller.close();
        } catch {
          // The runtime already closed or cancelled the stream.
        }
      };
      if (request.aborted) {
        onDisconnect();
        return;
      }
      request.addEventListener("abort", onDisconnect);
      keepalive = setInterval(() => controller.enqueue(encoder.encode(KEEPALIVE)), KEEPALIVE_MS);
      produce(stop.signal).then(
        (message) => {
          if (finish()) {
            controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
            );
            close();
          }
        },
        (error: unknown) => {
          if (finish()) {
            console.error(error);
            close();
          }
        },
      );
    },
    cancel() {
      finish();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
