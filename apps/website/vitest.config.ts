/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { getViteConfig } from "astro/config";

// Astro's Vite configuration lets the page test render .astro files through
// the container API (component-website §Verification). Root `pnpm test` runs
// Vitest from the repository root, so the Astro root is set to this package.
export default getViteConfig(
  {
    test: {
      name: "website",
      include: ["test/**/*.test.ts"],
    },
  },
  { root: fileURLToPath(new URL(".", import.meta.url)) },
);
