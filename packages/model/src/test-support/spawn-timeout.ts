/**
 * How long a test that starts processes is given before vitest kills it.
 *
 * The transport tests spawn a fake `claude` or `codex` several times each.
 * With the machine to themselves they take well under a second; with a second
 * gate of the same tree beside them they were measured past five, which is how
 * they came to fail against vitest's five-second default while passing alone
 * and in CI. Thirty seconds sits above that with room for a busier machine,
 * and is still low enough that a process which never exits fails the run in
 * bounded time rather than holding it open.
 *
 * It is a ceiling, not a budget: a test that reaches it has not been slow, it
 * has hung.
 *
 * Vitest's own default is left where it is: a test that starts no process
 * keeps five seconds, so a hang in one is still reported quickly.
 */
export const SPAWN_TEST_TIMEOUT_MS = 30_000;
