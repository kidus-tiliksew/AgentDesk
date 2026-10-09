import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// component-repository: each directory under packages/ and apps/ is its own
// Vitest project, so a package added later is discovered without editing
// this file. Vitest 4 reads no workspace file.
const workspaceDirs = ["packages", "apps"];

// Vitest 4 rejects a projects list that matches no directory. Until the first
// package exists, the root runs as the only project and finds no tests.
const hasPackage = workspaceDirs.some((dir) => {
  const path = fileURLToPath(new URL(`./${dir}/`, import.meta.url));
  return (
    existsSync(path) && readdirSync(path, { withFileTypes: true }).some((e) => e.isDirectory())
  );
});

export default defineConfig({
  test: {
    projects: hasPackage ? workspaceDirs.map((dir) => `${dir}/*`) : undefined,
  },
});
