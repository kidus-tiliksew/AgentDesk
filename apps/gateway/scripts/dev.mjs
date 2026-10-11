import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The root `pnpm dev` (component-repository §Toolchain): runs `convex dev`, the
// gateway's `wrangler dev`, and the mobile app's `expo start` when apps/mobile
// exists, together. When any of them exits, or the launcher is interrupted, it
// stops the others and exits.

const gateway = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gateway, "../..");
const mobile = resolve(root, "apps/mobile");
// How long a child has to stop after SIGINT before it is killed.
const STOP_GRACE_MS = 10_000;

const children = [
  {
    name: "convex",
    // Convex stays in the terminal's process group, so its sign-in and
    // deployment prompts can read the terminal and Ctrl-C reaches it.
    child: spawn(resolve(root, "node_modules/.bin/convex"), ["dev"], {
      cwd: root,
      stdio: "inherit",
    }),
    group: false,
  },
  {
    name: "gateway",
    // Wrangler leads its own process group, so stopping the group also stops
    // the workerd processes it starts. It reads no terminal input.
    child: spawn(resolve(gateway, "node_modules/.bin/wrangler"), ["dev"], {
      cwd: gateway,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    }),
    group: true,
  },
];

if (existsSync(resolve(mobile, "package.json"))) {
  children.push({
    name: "mobile",
    // Expo leads its own process group like wrangler, so stopping the group
    // also stops Metro. Convex holds the terminal, so Expo reads no input and
    // runs without its keyboard shortcuts.
    child: spawn(resolve(mobile, "node_modules/.bin/expo"), ["start"], {
      cwd: mobile,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    }),
    group: true,
  });
}

let exitCode;

function running(child) {
  return child.exitCode === null && child.signalCode === null;
}

// Signals each child that is still running. A group is signalled even after
// its leader exits, so no workerd process outlives wrangler.
function signal(name) {
  for (const { child, group } of children) {
    if (child.pid === undefined || (!group && !running(child))) {
      continue;
    }
    try {
      process.kill(group ? -child.pid : child.pid, name);
    } catch {
      // The process or group has already exited.
    }
  }
}

function stopAll(code) {
  if (exitCode !== undefined) {
    return;
  }
  exitCode = code;
  signal("SIGINT");
  setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS).unref();
}

function finished(name, code, how) {
  if (exitCode === undefined) {
    console.error(`[dev] ${name} exited (${how}); stopping the others`);
  }
  stopAll(code ?? 1);
  if (children.every(({ child }) => !running(child))) {
    signal("SIGKILL");
    process.exit(exitCode);
  }
}

for (const { name, child } of children) {
  child.on("exit", (code, sig) => finished(name, code, sig ?? `code ${code}`));
  child.on("error", (error) => finished(name, 1, error.message));
}

for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => stopAll(130));
}
