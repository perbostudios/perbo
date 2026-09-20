/**
 * How long a test that starts processes is given before vitest kills it.
 *
 * The tests this covers spawn a git repository, a fake `gh`, or a built entry
 * point several times each. With the machine to themselves the slowest take
 * two to three seconds; with a second gate of the same tree beside them the
 * same tests were measured between four and ten, which is how they came to
 * fail against vitest's five-second default while passing alone and in CI.
 * Thirty seconds sits above that measured range with room for a busier
 * machine, and is still low enough that a process which never exits fails the
 * run in bounded time rather than holding it open.
 *
 * It is a ceiling, not a budget. A test that reaches it has not been slow, it
 * has hung — and for the common case the deadline on each individual spawn
 * (`SPAWN_DEADLINE_MS` in `./open-build.ts`) fires first and says what the
 * process was doing, which this cannot.
 *
 * Vitest's own default is left where it is: a test that starts no process
 * keeps five seconds, so a hang in one is still reported quickly.
 */
export const SPAWN_TEST_TIMEOUT_MS = 30_000;
