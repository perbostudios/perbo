import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // vitest 4 excludes only node_modules and .git, so naming the two roots is
    // what keeps compiled copies under dist/ out of the run.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
