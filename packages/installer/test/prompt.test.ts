import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askQuestion, terminalPrompt } from "../src/cli.js";
import { TerminalReadError } from "../src/context.js";
import { kqueueError } from "./helpers.js";

/** A terminal-like output, so readline runs in terminal mode and handles Ctrl+C. */
function terminalOutput(): PassThrough {
  return Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
}

/** Each event the stream has listeners for, with their count. */
function listenerCounts(stream: PassThrough): Record<string, number> {
  return Object.fromEntries(stream.eventNames().map((e) => [String(e), stream.listenerCount(e)]));
}

/**
 * A terminal-like input whose raw mode is recorded and whose resume, which
 * readline calls while it is constructed, runs `onResume`.
 */
function terminalInput(onResume: (input: PassThrough) => void) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
  });
  input.resume = () => {
    onResume(input);
    return input;
  };
  return input;
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

  it("undoes readline's listeners and raw mode when its construction throws", async () => {
    const error = kqueueError();
    const input = terminalInput(() => {
      throw error;
    });
    const before = listenerCounts(input);
    const answer = askQuestion(input, terminalOutput(), "q? ");
    const rejection = await answer.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(rejection).toBeInstanceOf(TerminalReadError);
    expect((rejection as TerminalReadError).readError).toBe(error);
    expect(listenerCounts(input)).toEqual(before);
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  it("rejects once and undoes construction when the input fails while readline is constructed", async () => {
    const error = kqueueError();
    const input = terminalInput((stream) => {
      stream.emit("error", error);
    });
    const before = listenerCounts(input);
    const rejection = await askQuestion(input, terminalOutput(), "q? ").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(rejection).toBeInstanceOf(TerminalReadError);
    expect((rejection as TerminalReadError).readError).toBe(error);
    expect(listenerCounts(input)).toEqual(before);
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  it("passes a question that fails to start through unchanged and closes the interface", async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        input.isRaw = mode;
        return input;
      },
    });
    const output = terminalOutput();
    const error = new Error("EPIPE: broken pipe, write");
    output.write = () => {
      throw error;
    };
    const errorListeners = input.listenerCount("error");
    await expect(askQuestion(input, output, "q? ")).rejects.toBe(error);
    expect(input.listenerCount("error")).toBe(errorListeners);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.isRaw).toBe(false);
  });
});

describe("terminalPrompt", () => {
  it("rejects every later prompt without touching the input after a read error", async () => {
    let resumes = 0;
    const input = terminalInput(() => {
      resumes++;
      throw kqueueError();
    });
    const prompt = terminalPrompt(input, terminalOutput());
    const first = await prompt("q? ").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(first).toBeInstanceOf(TerminalReadError);
    const before = listenerCounts(input);
    await expect(prompt("again? ")).rejects.toBe(first);
    expect(resumes).toBe(1);
    expect(listenerCounts(input)).toEqual(before);
  });

  it("keeps prompting after an answer", async () => {
    const input = new PassThrough();
    const prompt = terminalPrompt(input, new PassThrough());
    const first = prompt("q? ");
    input.write("one\n");
    await expect(first).resolves.toBe("one");
    const second = prompt("q? ");
    input.write("two\n");
    await expect(second).resolves.toBe("two");
  });
});
