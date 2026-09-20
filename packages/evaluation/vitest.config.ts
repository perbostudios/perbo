import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // `corpus/**` holds fixture repositories, and several of them ship a
    // `*.test.ts` of their own — that file is the thing under review, not a
    // test of this package. Collecting it would run the corpus as if it were
    // the suite.
    exclude: ["corpus/**", "dist/**", "node_modules/**"],
  },
});
