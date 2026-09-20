import { defineConfig } from "vitest/config";

/**
 * A test sits beside the module it covers; `test/` holds the suites whose
 * subject is the built package, and `test/fixtures/` — an authored repository
 * `perbo index` reads — is data rather than code this package runs.
 *
 * `exclude` replaces vitest's own list rather than adding to it, so the
 * directories it would have skipped are repeated here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/fixtures/**", ".test-dist-*/**", "dist/**", "node_modules/**"],
  },
});
