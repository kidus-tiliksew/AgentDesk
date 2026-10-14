import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESSES } from "../src/harnesses.js";
import {
  allFiles,
  cleanupSandboxes,
  GUIDANCE_FILE,
  makeContext,
  makeSandbox,
  read,
  write,
} from "./helpers.js";

afterEach(cleanupSandboxes);

// component-installer §agentdesk context: the session-start hooks run
// `agentdesk context --harness <id>`, which prints the embedded guidance.

const GUIDANCE = read(GUIDANCE_FILE);
const WITHOUT_SKILL_LINE = `${GUIDANCE.trimEnd().split("\n").slice(0, -1).join("\n")}\n`;

/** A context whose fetch fails the test, over a home with a state file it must not read. */
function offline(options: Parameters<typeof makeContext>[1] = {}) {
  const sandbox = makeSandbox();
  // A malformed state file stops every command that reads state.
  write(join(sandbox.home, ".config", "agentdesk", "state.json"), "{ not json");
  const h = makeContext(sandbox, options);
  let fetched = false;
  h.ctx.fetch = async () => {
    fetched = true;
    throw new Error("agentdesk context made a network call");
  };
  return { sandbox, h, fetched: () => fetched };
}

describe("agentdesk context", () => {
  it.each(["claude-code", "codex"])("prints GUIDANCE.md as plain text for %s", async (id) => {
    const { sandbox, h, fetched } = offline();
    const before = allFiles(sandbox.root);
    expect(await h.run(["context", "--harness", id])).toBe(0);
    expect(h.err).toEqual([]);
    expect(`${h.out.join("\n")}\n`).toBe(GUIDANCE);
    expect(fetched()).toBe(false);
    expect(allFiles(sandbox.root)).toEqual(before);
  });

  it("prints one additional_context JSON object for cursor", async () => {
    const { h, fetched } = offline();
    expect(await h.run(["context", "--harness", "cursor"])).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] as string)).toEqual({ additional_context: GUIDANCE });
    expect(fetched()).toBe(false);
  });

  it("omits the last line, which points to the skill, for a harness without skills", async () => {
    const harnesses = HARNESSES.map((harness) => ({ ...harness, supportsSkills: false }));
    expect(WITHOUT_SKILL_LINE).not.toContain("skill");
    const plain = offline({ harnesses }).h;
    expect(await plain.run(["context", "--harness", "codex"])).toBe(0);
    expect(`${plain.out.join("\n")}\n`).toBe(WITHOUT_SKILL_LINE);
    const cursor = offline({ harnesses }).h;
    expect(await cursor.run(["context", "--harness", "cursor"])).toBe(0);
    expect(JSON.parse(cursor.out[0] as string)).toEqual({ additional_context: WITHOUT_SKILL_LINE });
  });

  it.each([
    [[]],
    [["--harness"]],
    [["--harness", "vim"]],
    [["--harness", "codex", "extra"]],
    [["--harness", "codex", "--yes"]],
  ])("is a usage error with status 2 for %j", async (args) => {
    const { h } = offline();
    expect(await h.run(["context", ...args])).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("Usage: agentdesk");
  });
});
