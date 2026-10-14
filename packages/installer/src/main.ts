// Entry for the bundle and the Bun-compiled release binaries (DEC-10). Runtime
// code uses Node APIs only, so the same bundle runs under Node 20+ and Bun.
import { createNodeContext, runCli } from "./cli.js";

const ctx = createNodeContext();
runCli(process.argv.slice(2), ctx).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("agentdesk failed unexpectedly.\n");
    process.exitCode = 1;
  },
);
