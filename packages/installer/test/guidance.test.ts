import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_GUIDANCE } from "../src/guidance.js";
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

/**
 * A context whose fetch fails the test, over a home with a state file it must
 * not read; with `noState`, over a home with no state file at all.
 */
function offline(options: Parameters<typeof makeContext>[1] = {}, noState = false) {
  const sandbox = makeSandbox();
  // A malformed state file stops every command that reads state.
  if (!noState) write(join(sandbox.home, ".config", "agentdesk", "state.json"), "{ not json");
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

// component-installer §`agentdesk context`, req-installation-and-agent-guidance
// AC-10.5: AGENTDESK_PARENT_SESSION set to any value other than the empty
// string marks a child session, which gets the child guidance in place of the
// whole standing guidance.

const PARENT = "AGENTDESK_PARENT_SESSION";
const HARNESS_IDS = ["claude-code", "codex", "cursor"] as const;
const PARENT_VALUES = ["0", "false", " ", "conveyor-session 7f3a"];

/** The standing guidance output for `id`, exactly as `context` prints it with the variable unset. */
function standingOutput(id: string, text = GUIDANCE): string {
  return id === "cursor" ? `${JSON.stringify({ additional_context: text })}\n` : text;
}

/** Joins captured lines as the CLI writes them, one newline after each. */
function printed(out: string[]): string {
  return out.map((line) => `${line}\n`).join("");
}

describe("agentdesk context in a child session", () => {
  it("has the confirmed child guidance text", () => {
    expect(CHILD_GUIDANCE).toBe(
      "AgentDesk belongs to the agent that started this session. Report progress and questions to that agent. Do not call any AgentDesk tool.",
    );
  });

  describe.each(HARNESS_IDS)("for %s", (id) => {
    it("prints the standing guidance byte for byte with the variable unset", async () => {
      const { h } = offline();
      expect(h.ctx.env[PARENT]).toBeUndefined();
      expect(await h.run(["context", "--harness", id])).toBe(0);
      expect(h.err).toEqual([]);
      expect(printed(h.out)).toBe(standingOutput(id));
    });

    it("prints the standing guidance byte for byte with the variable empty", async () => {
      const unset = offline().h;
      expect(await unset.run(["context", "--harness", id])).toBe(0);
      const empty = offline({ env: { [PARENT]: "" } }).h;
      expect(await empty.run(["context", "--harness", id])).toBe(0);
      expect(empty.err).toEqual([]);
      expect(printed(empty.out)).toBe(printed(unset.out));
      expect(printed(empty.out)).toBe(standingOutput(id));
    });

    it.each(PARENT_VALUES)(
      "prints only the child guidance when the variable is %j",
      async (value) => {
        for (const noState of [false, true]) {
          const { sandbox, h, fetched } = offline({ env: { [PARENT]: value } }, noState);
          const before = allFiles(sandbox.root);
          expect(await h.run(["context", "--harness", id])).toBe(0);
          expect(h.err).toEqual([]);
          if (id === "cursor") {
            expect(h.out).toHaveLength(1);
            expect(JSON.parse(h.out[0] as string)).toEqual({ additional_context: CHILD_GUIDANCE });
          } else {
            expect(printed(h.out)).toBe(`${CHILD_GUIDANCE}\n`);
          }
          const output = printed(h.out);
          expect(output).not.toContain("skill");
          expect(output).not.toContain("`ask`");
          if (value.trim().length > 1) expect(output).not.toContain(value);
          expect(fetched()).toBe(false);
          expect(allFiles(sandbox.root)).toEqual(before);
          expect(h.ctx.env[PARENT]).toBe(value);
        }
      },
    );

    it("prints the same child guidance for a harness without skills", async () => {
      const harnesses = HARNESSES.map((harness) => ({ ...harness, supportsSkills: false }));
      const withSkills = offline({ env: { [PARENT]: "parent" } }).h;
      expect(await withSkills.run(["context", "--harness", id])).toBe(0);
      const without = offline({ harnesses, env: { [PARENT]: "parent" } }).h;
      expect(await without.run(["context", "--harness", id])).toBe(0);
      expect(without.err).toEqual([]);
      expect(printed(without.out)).toBe(printed(withSkills.out));
      const text =
        id === "cursor"
          ? (JSON.parse(without.out[0] as string) as { additional_context: string })
              .additional_context
          : printed(without.out).replace(/\n$/, "");
      expect(text).toBe(CHILD_GUIDANCE);
    });
  });

  it.each([[[]], [["--harness"]], [["--harness", "vim"]], [["--harness", "codex", "extra"]]])(
    "keeps usage errors at status 2 with the variable set, for %j",
    async (args) => {
      const { h } = offline({ env: { [PARENT]: "parent" } });
      expect(await h.run(["context", ...args])).toBe(2);
      expect(h.out).toEqual([]);
      expect(h.err.join("\n")).toContain("Usage: agentdesk");
    },
  );

  it.each([undefined, "", "parent"])(
    "fails the same way for a build without guidance when the variable is %j",
    async (value) => {
      const { h } = offline(value === undefined ? {} : { env: { [PARENT]: value } });
      h.ctx.guidance = undefined;
      expect(await h.run(["context", "--harness", "codex"])).toBe(1);
      expect(h.out).toEqual([]);
      expect(h.err.join("\n")).toContain("This build carries no standing guidance");
    },
  );
});
