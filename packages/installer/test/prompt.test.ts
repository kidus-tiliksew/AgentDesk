import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askQuestion } from "../src/cli.js";
import { TerminalReadError } from "../src/context.js";
import { kqueueError } from "./helpers.js";

/** A terminal-like output, so readline runs in terminal mode and handles Ctrl+C. */
function terminalOutput(): PassThrough {
  return Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
}

describe("askQuestion", () => {
  it("returns the typed answer and leaves no listener on the input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorListeners = input.listenerCount("error");
    const answer = askQuestion(input, output, "q? ");
    input.write("hello\n");
    await expect(answer).resolves.toBe("hello");
    expect(input.listenerCount("error")).toBe(errorListeners);
    expect(input.listenerCount("data") + input.listenerCount("keypress")).toBe(0);
  });

  it("rejects with TerminalReadError when the input fails while the question waits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorListeners = input.listenerCount("error");
    const answer = askQuestion(input, output, "q? ");
    const error = kqueueError();
    input.emit("error", error);
    const rejection = await answer.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(rejection).toBeInstanceOf(TerminalReadError);
    expect((rejection as TerminalReadError).readError).toBe(error);
    expect(input.listenerCount("error")).toBe(errorListeners);
    expect(input.listenerCount("data") + input.listenerCount("keypress")).toBe(0);
  });

  it("rejects with TerminalReadError when the input is already failing as the question starts", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = kqueueError();
    const answer = askQuestion(input, output, "q? ");
    // The same tick as the question: before any input arrives.
    input.destroy(error);
    await expect(answer).rejects.toBeInstanceOf(TerminalReadError);
  });

  it("settles once when the input fails twice", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askQuestion(input, output, "q? ");
    input.emit("error", kqueueError());
    expect(() => input.emit("error", kqueueError())).toThrow("EINVAL");
    await expect(answer).rejects.toBeInstanceOf(TerminalReadError);
  });

  it("passes Ctrl+C through unchanged rather than as a read error", async () => {
    const input = new PassThrough();
    const answer = askQuestion(input, terminalOutput(), "q? ");
    input.write("\u0003");
    const rejection = await answer.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(rejection).not.toBeInstanceOf(TerminalReadError);
    expect((rejection as Error).name).toBe("AbortError");
  });
});
