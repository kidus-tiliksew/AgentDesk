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
 * arguments one per line in ~/installer-args, what `tty` prints for its
 * standard input in ~/installer-tty, and, when that is no terminal, the first
 * read of its standard input (at most 64 bytes, so /dev/zero ends) in
 * ~/installer-stdin, and exits with FAKE_INSTALLER_STATUS. On a terminal it
 * also records in ~/installer-opened whether standard input is the file
 * /dev/tty itself: `tty` can name the concrete device for either.
 */
function stubBinary(asset: string): string {
  return `#!/bin/sh
echo ${asset}
printf '%s\\n' "$@" > "$HOME/installer-args"
if tty > "$HOME/installer-tty"; then
  if [ /dev/fd/0 -ef /dev/tty ]; then echo /dev/tty; else echo concrete; fi > "$HOME/installer-opened"
else
  dd bs=64 count=1 of="$HOME/installer-stdin" 2>/dev/null
fi
exit "\${FAKE_INSTALLER_STATUS:-0}"
`;
}

/** A ps that prints FAKE_PS_OUTPUT and exits with FAKE_PS_STATUS. */
const STUB_PS = `#!/bin/sh\nprintf '%s' "$FAKE_PS_OUTPUT"\nexit "\${FAKE_PS_STATUS:-0}"\n`;

/** A release download directory, a stub uname, and the script as the gateway serves it. */
function fixture(options: { corrupt?: string; origin?: string; ps?: boolean } = {}): Fixture {
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
  if (options.ps) {
    writeFileSync(join(stubs, "ps"), STUB_PS);
    chmodSync(join(stubs, "ps"), 0o755);
  }
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
  /** Output and status of the stub ps, for a fixture built with `ps`. */
  ps?: { output: string; status?: number };
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
        FAKE_PS_OUTPUT: options.ps?.output ?? "",
        FAKE_PS_STATUS: String(options.ps?.status ?? 0),
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
    // sh never reads its standard input, and it can exit before the write
    // lands (an unsupported platform fails at once), so EPIPE is expected.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

function installerArgs(f: Fixture): string[] {
  return read(join(f.home, "installer-args")).split("\n").slice(0, -1);
}

/** What the stub installer read first from its standard input. */
function installerStdin(f: Fixture): string {
  return read(join(f.home, "installer-stdin"));
}

const PYTHON_PTY =
  spawnSync("python3", ["-I", "-c", "import pty"], { stdio: "ignore" }).status === 0;

/**
 * Runs the script under sh as the session leader of a new pseudo-terminal,
 * which is its controlling terminal, through Python's pty module.
 */
function runScriptInTerminal(f: Fixture, uname: [string, string]): ScriptResult {
  const program = [
    "import os, pty, sys",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    "    os.execvp('sh', ['sh', sys.argv[1]])",
    "out = b''",
    "while True:",
    "    try:",
    "        chunk = os.read(fd, 4096)",
    "    except OSError:",
    "        break",
    "    if not chunk:",
    "        break",
    "    out += chunk",
    "sys.stdout.write(out.decode('utf-8', 'replace'))",
    "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-c", program, f.script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      HOME: f.home,
      PATH: [f.stubs, "/usr/bin", "/bin"].join(":"),
      AGENTDESK_DOWNLOAD_BASE: pathToFileURL(f.downloads).href,
      FAKE_UNAME_S: uname[0],
      FAKE_UNAME_M: uname[1],
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
    expect(read(join(f.home, "installer-tty"))).toBe("not a tty\n");
    expect(installerStdin(f)).toBe("");
  });

  it.skipIf(!PYTHON_PTY)(
    "gives the installer the controlling terminal's own device, not /dev/tty",
    () => {
      const f = fixture();
      const result = runScriptInTerminal(f, ["Linux", "x86_64"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("agentdesk-linux-x64");
      // The file opened, not only the name `tty` reports: Bun on macOS cannot poll /dev/tty.
      expect(read(join(f.home, "installer-opened"))).toBe("concrete\n");
      // macOS names /dev/ttysNNN and Linux /dev/pts/N.
      expect(read(join(f.home, "installer-tty")).trim()).toMatch(/^\/dev\/(ttys\d+|pts\/\d+)$/);
    },
  );

  it.each([
    ["zero", "the bare name"],
    ["  zero  \n", "padding"],
  ])("opens the device ps names (%j, %s) before /dev/tty", async (output) => {
    const f = fixture({ ps: true });
    const result = await runScript(f, ["Linux", "x86_64"], {
      input: "echo rest-of-the-script\n",
      ps: { output },
    });
    expect(result.status).toBe(0);
    // /dev/zero, not /dev/tty (unopenable here) or /dev/null: the device branch ran.
    expect(installerStdin(f)).toBe("\0".repeat(64));
  });

  it.each([
    ["", 0, "prints nothing"],
    ["?", 0, "prints ? (Linux, no terminal)"],
    ["??", 0, "prints ?? (macOS, no terminal)"],
    ["zero", 1, "fails"],
    ["zero null", 0, "prints two fields"],
    ["zero\nzero\n", 0, "prints two lines"],
    ["/dev/zero", 0, "prints an absolute path"],
    ["../dev/zero", 0, "prints a path outside /dev"],
    ["ttys-agentdesk-missing", 0, "names a device that does not exist"],
  ])(
    "falls back to /dev/tty, then /dev/null, when ps output is %j with status %i (%s)",
    async (output, status) => {
      const f = fixture({ ps: true });
      const result = await runScript(f, ["Linux", "x86_64"], {
        input: "echo rest-of-the-script\n",
        ps: { output, status },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(installerStdin(f)).toBe("");
    },
  );

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
