import { spawn, spawnSync } from "node:child_process";
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

/**
 * The binary each asset holds: it prints its asset name, records its
 * arguments one per line in ~/installer-args and its standard input in
 * ~/installer-stdin, and exits with FAKE_INSTALLER_STATUS.
 */
function stubBinary(asset: string): string {
  return `#!/bin/sh\necho ${asset}\nprintf '%s\\n' "$@" > "$HOME/installer-args"\ncat > "$HOME/installer-stdin"\nexit "\${FAKE_INSTALLER_STATUS:-0}"\n`;
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
    const content = stubBinary(asset);
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

interface RunOptions {
  extraPath?: string[];
  args?: string[];
  /** Standard input of sh, such as the rest of a piped script. */
  input?: string;
  status?: number;
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the script under sh in a new session, which has no controlling
 * terminal, as `curl | sh` without a TTY does: /dev/tty cannot be opened.
 */
function runScript(
  f: Fixture,
  uname: [string, string],
  options: RunOptions = {},
): Promise<ScriptResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", [f.script, ...(options.args ?? [])], {
      detached: true,
      env: {
        HOME: f.home,
        PATH: [f.stubs, ...(options.extraPath ?? []), "/usr/bin", "/bin"].join(":"),
        AGENTDESK_DOWNLOAD_BASE: pathToFileURL(f.downloads).href,
        FAKE_UNAME_S: uname[0],
        FAKE_UNAME_M: uname[1],
        FAKE_INSTALLER_STATUS: String(options.status ?? 0),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

function installerArgs(f: Fixture): string[] {
  return read(join(f.home, "installer-args")).split("\n").slice(0, -1);
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
    async (uname, asset) => {
      const f = fixture();
      const result = await runScript(f, uname);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const installed = join(f.home, ".local", "bin", "agentdesk");
      expect(read(installed)).toBe(stubBinary(asset));
      expect(mode(installed)).toBe(0o755);
      expect(result.stdout).toContain(`Downloading ${asset}...`);
      // AC-9.8: the installed binary runs the installation, with no second command.
      expect(result.stdout).toContain(`${asset}\n`);
      expect(installerArgs(f)).toEqual(["install", "--server", "https://agentdesk.test"]);
      expect(result.stdout).not.toContain("Next, run");
    },
  );

  it("passes its own arguments on after install --server <origin>", async () => {
    const f = fixture();
    const result = await runScript(f, ["Linux", "x86_64"], { args: ["--only", "codex", "--yes"] });
    expect(result.status).toBe(0);
    expect(installerArgs(f)).toEqual([
      "install",
      "--server",
      "https://agentdesk.test",
      "--only",
      "codex",
      "--yes",
    ]);
  });

  it("gives the installer /dev/null as standard input without a terminal, so it never reads the piped script", async () => {
    const f = fixture();
    const result = await runScript(f, ["Linux", "x86_64"], { input: "echo rest-of-the-script\n" });
    expect(result.status).toBe(0);
    expect(read(join(f.home, "installer-stdin"))).toBe("");
  });

  it("exits with the installer's status", async () => {
    const f = fixture();
    const result = await runScript(f, ["Linux", "x86_64"], { status: 3 });
    expect(result.status).toBe(3);
    expect(existsSync(join(f.home, ".local", "bin", "agentdesk"))).toBe(true);
  });

  it("prints a PATH hint when ~/.local/bin is not on PATH", async () => {
    const f = fixture();
    const result = await runScript(f, ["Linux", "x86_64"]);
    const hint = result.stdout.indexOf(`${join(f.home, ".local", "bin")} is not on your PATH`);
    expect(hint).toBeGreaterThan(-1);
    // The hint comes before the installer runs.
    expect(hint).toBeLessThan(result.stdout.indexOf("agentdesk-linux-x64\n"));
  });

  it("prints no PATH hint when ~/.local/bin is on PATH", async () => {
    const f = fixture();
    const result = await runScript(f, ["Linux", "x86_64"], {
      extraPath: [join(f.home, ".local", "bin")],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("is not on your PATH");
  });

  it("refuses a binary whose checksum does not match and installs nothing", async () => {
    const f = fixture({ corrupt: "agentdesk-linux-arm64" });
    const result = await runScript(f, ["Linux", "arm64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch for agentdesk-linux-arm64");
    expect(existsSync(join(f.home, ".local", "bin", "agentdesk"))).toBe(false);
  });

  it("refuses an unsupported platform", async () => {
    const f = fixture();
    const result = await runScript(f, ["FreeBSD", "x86_64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported operating system FreeBSD");
  });

  it("names no server when run unsubstituted", async () => {
    const f = fixture();
    writeFileSync(f.script, read(SCRIPT));
    const result = await runScript(f, ["Linux", "x86_64"], { args: ["--yes"] });
    expect(result.status).toBe(0);
    expect(installerArgs(f)).toEqual(["install", "--yes"]);
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
