// Release preflight (component-repository §Releases and deployment). It fails
// the release before anything is built or published when the tag is not a
// stable semver, when the tag differs from packages/installer/package.json's
// version, or when the public origin is unset or is not an https origin.
//
//   TAG=v1.2.3 AGENTDESK_PUBLIC_ORIGIN=https://agentdesk.example node .github/scripts/release-preflight.mjs
//
// It writes `version` and `origin` to $GITHUB_OUTPUT when that variable is set.
import { appendFileSync, readFileSync } from "node:fs";

// A prerelease or build-metadata tag is refused: install.sh downloads from
// releases/latest/download/, which serves only published, non-prerelease releases.
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const errors = [];

const tag = process.env.TAG ?? "";
const version = tag.startsWith("v") ? tag.slice(1) : "";
if (!STABLE_SEMVER.test(version)) {
  errors.push(
    `Tag ${JSON.stringify(tag)} is not v<major>.<minor>.<patch>; prerelease and build tags are not released.`,
  );
} else {
  const manifest = new URL("../../packages/installer/package.json", import.meta.url);
  const packageVersion = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (packageVersion !== version) {
    errors.push(
      `Tag version ${version} differs from packages/installer/package.json version ${packageVersion}.`,
    );
  }
}

const rawOrigin = process.env.AGENTDESK_PUBLIC_ORIGIN ?? "";
let origin = "";
if (rawOrigin === "") {
  errors.push("The repository variable AGENTDESK_PUBLIC_ORIGIN is not set.");
} else {
  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    url = undefined;
  }
  if (
    url?.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  ) {
    origin = url.origin;
  } else {
    errors.push(
      `AGENTDESK_PUBLIC_ORIGIN ${JSON.stringify(rawOrigin)} is not an https origin such as https://agentdesk.example.`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.log(`::error::${error}`);
  process.exit(1);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\norigin=${origin}\n`);
}
console.log(`Releasing agentdesk ${version} with default server ${origin}`);
