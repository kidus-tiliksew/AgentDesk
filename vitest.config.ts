import { defineConfig } from "vitest/config";

// component-repository: each directory under packages/ and apps/ is its own
// Vitest project, so a package added later is discovered without editing
// this file. The Convex backend in convex/ is one more project. Vitest 4 reads
// no workspace file. apps/mobile is excluded: its tests run under Jest with
// jest-expo, which root `pnpm test` runs after Vitest.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "!apps/mobile", "convex"],
  },
});
