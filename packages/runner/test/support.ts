import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";

/**
 * The path `test/security.test.ts` spells this constant as. That file is
 * protected, so it cannot be edited to import it from `@perbo/test-support`
 * where every other file in the package does.
 */
export { SPAWN_TEST_TIMEOUT_MS };
