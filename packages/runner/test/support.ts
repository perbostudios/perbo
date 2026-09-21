import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";

/**
 * The path two test files this package does not edit spell their fixtures as:
 * `test/security.test.ts`, which is protected, and
 * `test/subagent-guard-state.test.ts`. The fixtures themselves are
 * `@perbo/test-support`; every other file in the package imports them from
 * there.
 */
export { SPAWN_TEST_TIMEOUT_MS };

/**
 * Temporary directories for the test file that imports this module.
 *
 * `scratchDirectories` registers its `afterAll` on the importing file, so a
 * directory lives as long as the file that made it — the lifetime a `beforeAll`
 * fixture needs.
 */
export const scratch = scratchDirectories("perbo-runner-");
