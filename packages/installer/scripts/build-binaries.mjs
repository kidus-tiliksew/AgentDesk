// Compiles the bundled installer into standalone binaries with Bun and writes
// SHA256SUMS over them (component-installer §Build and distribution; DEC-10).
// The binaries are the only distribution; install.sh downloads them.
// The release workflow runs this; ordinary tests and CI need no Bun.
//
//   AGENTDESK_SERVER_ORIGIN=https://agentdesk.example node scripts/build-binaries.mjs [--outdir <dir>]
//
// BUN names the bun executable (default: bun on PATH).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBundle } from "./build.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bun targets and the release asset names install.sh downloads. */
export const TARGETS = [
  { target: "bun-darwin-arm64", asset: "agentdesk-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "agentdesk-darwin-x64" },
  { target: "bun-linux-x64", asset: "agentdesk-linux-x64" },
  { target: "bun-linux-arm64", asset: "agentdesk-linux-arm64" },
];

export function sha256sums(dir, assets) {
  return assets
    .map(
      (asset) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, asset)))
          .digest("hex")}  ${asset}\n`,
    )
    .join("");
}

export async function buildBinaries({ outdir, origin, bun = "bun" }) {
  mkdirSync(outdir, { recursive: true });
  const bundle = join(outdir, "agentdesk.mjs");
  await buildBundle({ outfile: bundle, origin });
  for (const { target, asset } of TARGETS) {
    const result = spawnSync(
      bun,
      ["build", "--compile", `--target=${target}`, bundle, "--outfile", join(outdir, asset)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error(`bun build --compile failed for ${target}`);
  }
  const sums = sha256sums(
    outdir,
    TARGETS.map((t) => t.asset),
  );
  writeFileSync(join(outdir, "SHA256SUMS"), sums);
  return { outdir, assets: TARGETS.map((t) => t.asset) };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.AGENTDESK_SERVER_ORIGIN;
  if (!origin) {
    console.error("Set AGENTDESK_SERVER_ORIGIN to the server origin this build defaults to.");
    process.exit(1);
  }
  const outdir = resolve(argValue("--outdir") ?? join(packageDir, "dist", "release"));
  buildBinaries({ outdir, origin, bun: process.env.BUN || "bun" }).then(
    (result) => console.log(`Wrote ${result.assets.join(", ")} and SHA256SUMS to ${result.outdir}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
