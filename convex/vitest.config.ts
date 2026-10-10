import { defineProject } from "vitest/config";

// convex-test runs Convex functions in the edge runtime, which matches the
// default Convex runtime more closely than Node.
export default defineProject({
  test: {
    name: "convex",
    environment: "edge-runtime",
    include: ["**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
