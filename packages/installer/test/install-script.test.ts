import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandboxes, makeSandbox, mode, PACKAGE_DIR, read } from "./helpers.js";

afterEach(cleanupSandboxes);

const SCRIPT = join(PACKAGE_DIR, "install.sh");
const PLACEHOLDER = "__AGENTDESK_PUBLIC_ORIGIN__";
const ASSETS = [
  "agentdesk-darwin-arm64",
  "agentdesk-darwin-x64",
  "agentdesk-linux-x64",
  "agentdesk-linux-arm64",
];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface Fixture {
  root: string;
  home: string;
  downloads: string;
  stubs: string;
  script: string;
}

/** A release download directory, a stub uname, and the script as the gateway serves it. */
function fixture(options: { corrupt?: string; origin?: string } = {}): Fixture {
  const sandbox = makeSandbox();
  const downloads = join(sandbox.root, "downloads");
  const stubs = join(sandbox.root, "stubs");
  mkdirSync(downloads);
  mkdirSync(stubs);
  const sums: string[] = [];
  for (const asset of ASSETS) {
    const content = `#!/bin/sh\necho ${asset}\n`;
    writeFileSync(
      join(downloads, asset),
      options.corrupt === asset ? `${content}tampered\n` : content,
    );
    sums.push(`${sha256(content)}  ${asset}\n`);
  }
  writeFileSync(join(downloads, "SHA256SUMS"), sums.join(""));
  writeFileSync(
    join(stubs, "uname"),
    '#!/bin/sh\ncase "$1" in\n  -s) echo "$FAKE_UNAME_S" ;;\n  -m) echo "$FAKE_UNAME_M" ;;\nesac\n',
  );
  chmodSync(join(stubs, "uname"), 0o755);
  const script = join(sandbox.root, "install.sh");
  writeFileSync(
    script,
    read(SCRIPT).replace(PLACEHOLDER, options.origin ?? "https://agentdesk.test"),
  );
  return { root: sandbox.root, home: sandbox.home, downloads, stubs, script };
}

function runScript(f: Fixture, uname: [string, string], extraPath: string[] = []) {
  return spawnSync("sh", [f.script], {
    encoding: "utf8",
    env: {
      HOME: f.home,
      PATH: [f.stubs, ...extraPath, "/usr/bin", "/bin"].join(":"),
      AGENTDESK_DOWNLOAD_BASE: pathToFileURL(f.downloads).href,
      FAKE_UNAME_S: uname[0],
      FAKE_UNAME_M: uname[1],
    },
  });
}

describe("install.sh", () => {
  it("carries exactly one server-origin placeholder", () => {
    expect(read(SCRIPT).split(PLACEHOLDER)).toHaveLength(2);
  });

  it("downloads from the latest GitHub Release by default", () => {
    expect(read(SCRIPT)).toContain(
      "https://github.com/kidus-tiliksew/AgentDesk/releases/latest/download",
    );
  });

  it.each([
    [["Darwin", "arm64"], "agentdesk-darwin-arm64"],
    [["Darwin", "x86_64"], "agentdesk-darwin-x64"],
    [["Linux", "x86_64"], "agentdesk-linux-x64"],
    [["Linux", "aarch64"], "agentdesk-linux-arm64"],
  ] as [[string, string], string][])(
    "installs the verified %j binary %s to ~/.local/bin",
    (uname, asset) => {
      const f = fixture();
      const result = runScript(f, uname);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const installed = join(f.home, ".local", "bin", "agentdesk");
      expect(read(installed)).toBe(`#!/bin/sh\necho ${asset}\n`);
      expect(mode(installed)).toBe(0o755);
      expect(result.stdout).toContain(`Downloading ${asset}...`);
      expect(result.stdout).toContain(
        "Next, run: agentdesk install --server https://agentdesk.test",
      );
    },
  );

  it("prints a PATH hint when ~/.local/bin is not on PATH", () => {
    const f = fixture();
    const result = runScript(f, ["Linux", "x86_64"]);
    expect(result.stdout).toContain(`${join(f.home, ".local", "bin")} is not on your PATH`);
  });

  it("prints no PATH hint when ~/.local/bin is on PATH", () => {
    const f = fixture();
    const result = runScript(f, ["Linux", "x86_64"], [join(f.home, ".local", "bin")]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("is not on your PATH");
  });

  it("refuses a binary whose checksum does not match and installs nothing", () => {
    const f = fixture({ corrupt: "agentdesk-linux-arm64" });
    const result = runScript(f, ["Linux", "arm64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch for agentdesk-linux-arm64");
    expect(existsSync(join(f.home, ".local", "bin", "agentdesk"))).toBe(false);
  });

  it("refuses an unsupported platform", () => {
    const f = fixture();
    const result = runScript(f, ["FreeBSD", "x86_64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported operating system FreeBSD");
  });

  it("names no server when run unsubstituted", () => {
    const f = fixture();
    writeFileSync(f.script, read(SCRIPT));
    const result = runScript(f, ["Linux", "x86_64"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Next, run: agentdesk install\n");
  });
});

describe("scripts/build-binaries.mjs", () => {
  it("compiles the four Bun targets to the release asset names and writes SHA256SUMS", () => {
    const sandbox = makeSandbox();
    const log = join(sandbox.root, "bun.log");
    const bun = join(sandbox.root, "fake-bun");
    // The stub records its arguments and writes a file at --outfile.
    writeFileSync(
      bun,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nfor last; do :; done\nprintf 'binary %s\\n' "$3" > "$last"\n`,
    );
    chmodSync(bun, 0o755);
    const outdir = join(sandbox.root, "release");
    const result = spawnSync(
      process.execPath,
      [join(PACKAGE_DIR, "scripts", "build-binaries.mjs"), "--outdir", outdir],
      {
        encoding: "utf8",
        env: { ...process.env, BUN: bun, AGENTDESK_SERVER_ORIGIN: "https://agentdesk.test" },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const bundle = join(outdir, "agentdesk.mjs");
    expect(read(log).trim().split("\n")).toEqual(
      ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"].map(
        (target, i) =>
          `build --compile --target=${target} ${bundle} --outfile ${join(outdir, ASSETS[i] as string)}`,
      ),
    );
    expect(read(join(outdir, "SHA256SUMS"))).toBe(
      ASSETS.map(
        (asset) =>
          `${createHash("sha256")
            .update(readFileSync(join(outdir, asset)))
            .digest("hex")}  ${asset}\n`,
      ).join(""),
    );
  });

  it("refuses to build without AGENTDESK_SERVER_ORIGIN", () => {
    const env = { ...process.env };
    delete env.AGENTDESK_SERVER_ORIGIN;
    const result = spawnSync(
      process.execPath,
      [join(PACKAGE_DIR, "scripts", "build.mjs"), "--outfile", "/nonexistent/x"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENTDESK_SERVER_ORIGIN");
  });
});
