import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as contract from "@agentdesk/contract";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

describe("public exports", () => {
  test("the package name resolves to the source barrel", async () => {
    const source = await import("../src/index.js");
    expect(Object.keys(contract).sort()).toEqual(Object.keys(source).sort());
    for (const name of [
      "ERROR_CODES",
      "errorCodeSchema",
      "errorBodySchema",
      "normalizeTopic",
      "topicMatches",
      "topicSchema",
      "topicInputSchema",
      "answerSchema",
      "answerSubmissionSchema",
      "validateAnswer",
      "decisionInputFieldsSchema",
      "decisionInputSchema",
      "validateDecisionInput",
      "statusInputSchema",
      "decisionSchema",
      "agentSessionSchema",
      "webhookEventSchema",
    ]) {
      expect(contract, name).toHaveProperty(name);
    }
  });
});

// component-contract §Package: no I/O and no clock reads.
describe("purity", () => {
  const files = readdirSync(srcDir).filter((file) => file.endsWith(".ts"));

  test("source modules import only zod and each other", () => {
    for (const file of files) {
      const text = readFileSync(`${srcDir}${file}`, "utf8");
      for (const [, specifier] of text.matchAll(/from "([^"]+)"/g)) {
        expect(specifier === "zod" || /^\.\/[a-z-]+\.js$/.test(specifier ?? ""), file).toBe(true);
      }
    }
  });

  test.each([
    "Date.now",
    "new Date",
    "performance.now",
    "Math.random",
    "fetch(",
    "process.",
    "globalThis",
    "require(",
    "import(",
  ])("no source module uses %s", (token) => {
    for (const file of files) {
      expect(readFileSync(`${srcDir}${file}`, "utf8"), file).not.toContain(token);
    }
  });
});

// Convex and the Worker bundle the package from source. Each fixture is
// bundled for a browser-like platform with zod and the contract inlined, so a
// Node built-in or an unresolvable import fails the build.
describe.each(["convex-consumer", "worker-consumer"])("%s bundle", (fixture) => {
  async function bundle() {
    return build({
      entryPoints: [`${packageDir}test/fixtures/${fixture}.ts`],
      absWorkingDir: packageDir,
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
  }

  test("builds with the contract source and zod inlined", async () => {
    const result = await bundle();
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContain("src/index.ts");
    expect(inputs.some((input) => input.includes("node_modules/zod/"))).toBe(true);
    expect(Object.values(result.metafile.outputs)[0]?.imports).toEqual([]);
  });

  test("runs the bundled validators", async () => {
    const [output] = (await bundle()).outputFiles;
    const url = `data:text/javascript;base64,${Buffer.from(output?.text ?? "").toString("base64")}`;
    const module = await import(/* @vite-ignore */ url);
    if (fixture === "convex-consumer") {
      const now = Date.parse("2026-01-01T00:00:00Z");
      expect(module.create({ title: "t", input_type: "approve_reject", topic: "A" }, now)).toEqual({
        code: "ok",
      });
      expect(
        module.create(
          { title: "t", input_type: "free_text", topic: "a", deadline: "2025-01-01T00:00:00Z" },
          now,
        ),
      ).toEqual({ code: "invalid", field: "deadline" });
    } else {
      expect(module.status({ topic: "Repo/X", state: "working", line: "Testing" })).toBe(
        "ok: working",
      );
      expect(module.status({ topic: "a b", state: "working", line: "Testing" })).toBe(
        "invalid: topic",
      );
      expect(module.status({ topic: "repo", state: "working", line: "x", link: "/x" })).toBe(
        "invalid: link",
      );
    }
  });
});

describe("bundle guard", () => {
  test("a Node built-in import fails the browser build", async () => {
    await expect(
      build({
        stdin: { contents: 'import "node:fs";', resolveDir: packageDir },
        bundle: true,
        platform: "browser",
        write: false,
        logLevel: "silent",
      }),
    ).rejects.toThrow();
  });
});
