import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

// component-gateway §Verification: tests run inside workerd with the Worker's
// own wrangler.toml, and fake the Convex service client.
export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    name: "gateway",
    include: ["test/**/*.test.ts"],
  },
});
