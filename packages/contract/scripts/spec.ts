// `pnpm spec` regenerates spec/ from the route table and read shapes.
// `pnpm spec:check` (--check) fails, naming each differing file, when the
// committed spec/ differs from a fresh generation (component-contract §Route
// table and specification; req-public-api-and-webhooks AC-1.1).
import { checkSpec, renderSpec, SPEC_DIR, writeSpec } from "./spec-lib.js";

if (process.argv.includes("--check")) {
  const differences = checkSpec();
  if (differences.length > 0) {
    console.error("spec/ is stale. Run `pnpm spec` and commit the result. Differing files:");
    for (const { path, kind } of differences) console.error(`  ${kind}: spec/${path}`);
    process.exitCode = 1;
  } else {
    console.log("spec/ matches the contract.");
  }
} else {
  const files = renderSpec();
  writeSpec(SPEC_DIR, files);
  for (const path of files.keys()) console.log(`wrote spec/${path}`);
}
