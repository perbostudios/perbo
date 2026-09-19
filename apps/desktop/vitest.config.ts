import { defineConfig } from "vitest/config";
// These tests mount the whole app, or drive a real host over a temporary
// checkout, and their files run beside each other. The ceilings are for work
// that has stopped rather than work that is queued behind another core: at
// thirty seconds the slowest of them finished a hair inside on an idle machine
// and a hair outside on a busy one, which measures the machine and not the
// code. A test that is genuinely stuck still fails, a minute later.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
