import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/config.js";
import { tempPath } from "../src/defaults.js";
import { cleanupSandboxes, makeSandbox, read, write } from "./helpers.js";

// The no-follow write that Antigravity uses (DEC-24(1)) creates its temporary
// file exclusively. When the write into that new file fails, for example on a
// full disk, the file this run created is removed, so a retry in the same
// process can create it again. An entry that already existed is never removed.

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
const writeSpy = vi.mocked(fs.writeFileSync);

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  writeSpy.mockReset();
  writeSpy.mockImplementation(actual.writeFileSync);
  cleanupSandboxes();
});

function noSpace(): never {
  throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

describe("a failed no-follow write", () => {
  it("removes the temporary file it created, keeps the file, and lets a retry succeed", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "config", "hooks.json");
    write(file, "{}\n");
    writeSpy.mockImplementationOnce(noSpace);

    expect(() => writeFileAtomic(file, "new\n", 0o600, true)).toThrow(/ENOSPC/);
    expect(fs.existsSync(tempPath(file))).toBe(false);
    expect(read(file)).toBe("{}\n");

    writeSpy.mockImplementation(actual.writeFileSync);
    writeFileAtomic(file, "new\n", 0o600, true);
    expect(read(file)).toBe("new\n");
    expect(fs.existsSync(tempPath(file))).toBe(false);
  });

  it("leaves an existing temporary entry in place when it refuses", () => {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, "config", "hooks.json");
    write(file, "{}\n");
    write(tempPath(file), "someone else's\n");
    expect(() => writeFileAtomic(file, "new\n", 0o600, true)).toThrow(/already exists/);
    expect(read(tempPath(file))).toBe("someone else's\n");
    expect(read(file)).toBe("{}\n");
  });
});
