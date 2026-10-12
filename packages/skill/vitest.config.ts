import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "skill",
    include: ["test/**/*.test.ts"],
  },
});
