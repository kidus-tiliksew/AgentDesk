import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "installer",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
