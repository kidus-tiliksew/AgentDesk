// Bundles the installer into one Node 20+ ESM file with the skill, the standing
// guidance, and the default server compiled in (component-installer §Build and
// distribution). scripts/build-binaries.mjs compiles this bundle.
//
//   AGENTDESK_SERVER_ORIGIN=https://agentdesk.example node scripts/build.mjs [--outfile <path>]
//
// AGENTDESK_SERVER_ORIGIN is a required build input: the release task sets the
// public origin, and tests set a fake one. No default origin is invented here.
import { chmodSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolves a file through @agentdesk/skill's own export map, without a dependency link. */
function resolveSkillExport(name) {
  const skillManifest = join(packageDir, "..", "skill", "package.json");
  return createRequire(skillManifest).resolve(`@agentdesk/skill/agentdesk/${name}`);
}

export function resolveSkillFile() {
  return resolveSkillExport("SKILL.md");
}

export function resolveGuidanceFile() {
  return resolveSkillExport("GUIDANCE.md");
}

/** Reads metadata.version from the skill's frontmatter. */
export function skillVersionOf(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const metadata =
    frontmatter && /^metadata:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(frontmatter)?.[1];
  return metadata ? /^[ \t]+version:\s*["']?([^"'\s#]+)["']?/m.exec(metadata)?.[1] : undefined;
}

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AGENTDESK_SERVER_ORIGIN is not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("AGENTDESK_SERVER_ORIGIN must be an http or https URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export async function buildBundle({ outfile, origin }) {
  const skillContent = readFileSync(resolveSkillFile(), "utf8");
  const skillVersion = skillVersionOf(skillContent);
  if (!skillVersion) throw new Error("the skill file has no metadata.version");
  const guidance = readFileSync(resolveGuidanceFile(), "utf8");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  await build({
    entryPoints: [join(packageDir, "src", "main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "inline",
    logLevel: "warning",
    define: {
      __AGENTDESK_DEFAULT_SERVER__: JSON.stringify(normalizeOrigin(origin)),
      __AGENTDESK_SKILL_CONTENT__: JSON.stringify(skillContent),
      __AGENTDESK_SKILL_VERSION__: JSON.stringify(skillVersion),
      __AGENTDESK_GUIDANCE__: JSON.stringify(guidance),
      __AGENTDESK_VERSION__: JSON.stringify(manifest.version),
    },
  });
  chmodSync(outfile, 0o755);
  return { outfile, skillVersion };
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
  const outfile = resolve(argValue("--outfile") ?? join(packageDir, "dist", "agentdesk.mjs"));
  buildBundle({ outfile, origin }).then(
    (result) => console.log(`Built ${result.outfile} with skill ${result.skillVersion}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
