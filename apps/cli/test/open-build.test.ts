import { expect, it } from "vitest";
import { spawnBuilt } from "../src/test-support/open-build.js";

/**
 * `spawnBuilt` itself (SCP-191, ac_3): a spawned process that never exits
 * fails in bounded time with its captured stdout and stderr in the message,
 * and an ordinary non-zero exit is not treated as a failure at all.
 */

// A cold `node -e` spawn under load can take a while to reach its first
// statement; 3000ms gives it enough headroom to write "started" before the
// deadline kills it, so the test asserts the property (the message names the
// deadline and carries both captured sections) rather than exact timing.
const DEADLINE_MS = 3_000;

/** A cold `node -e` under the full gate's load has taken over 500 ms; this is the margin an ordinary exit gets. */
const SPAWN_MARGIN_MS = 5_000;

/** `spawnBuilt`'s own margin (`SPAWN_DEADLINE_MS` in `../src/test-support/open-build.js`) for a cold spawn under load. */
const SPAWN_BUILT_TIMEOUT_MS = 20_000;

it("throws within its deadline, naming the deadline and the process's captured output, when the child never exits", () => {
  let thrown: unknown;
  try {
    spawnBuilt(["-e", "process.stdout.write('started\\n'); setInterval(() => {}, 1000);"], {
      timeout: DEADLINE_MS,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain(`did not exit within ${DEADLINE_MS}ms`);
  expect(message).toContain("--- stdout ---\nstarted\n");
  expect(message).toContain("--- stderr ---\n");
}, SPAWN_BUILT_TIMEOUT_MS);

it("does not throw on an ordinary non-zero exit, and returns the status and stderr the child wrote", () => {
  const result = spawnBuilt(
    ["-e", "process.stderr.write('oops\\n'); process.exit(2);"],
    { timeout: SPAWN_MARGIN_MS },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("oops\n");
}, SPAWN_BUILT_TIMEOUT_MS);
