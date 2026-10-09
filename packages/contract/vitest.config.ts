import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "contract",
    include: ["test/**/*.test.ts"],
  },
});
