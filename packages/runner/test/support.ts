import { Socket } from "node:net";
import { vi } from "vitest";
import { scratchDirectories } from "@perbo/test-support";

/**
 * How long a test that starts processes is given before vitest kills it.
 *
 * The tests this covers spawn a git repository, a worktree, or a fake agent
 * several times each. With the machine to themselves the slowest take two to
 * three seconds; with a second gate of the same tree beside them the same
 * tests were measured between four and ten, which is how they came to fail
 * against vitest's five-second default while passing alone and in CI. Thirty
 * seconds sits above that measured range with room for a busier machine, and
 * is still low enough that a process which never exits fails the run in
 * bounded time rather than holding it open.
 *
 * It is a ceiling, not a budget: a test that reaches it has not been slow, it
 * has hung. Where a suite already declares a larger deadline of its own, that
 * one is the measured need and stays.
 *
 * Vitest's own default is left where it is: a test that starts no process
 * keeps five seconds, so a hang in one is still reported quickly.
 */
export const SPAWN_TEST_TIMEOUT_MS = 30_000;

/**
 * Temporary directories that live as long as the test file that imports this
 * module, because the `afterAll` is registered on that file.
 */
export const scratch = scratchDirectories("perbo-runner-");

/**
 * Every outbound connection this process asks for while something runs.
 *
 * `fetch` is the call a hosted plane would be reached by, and watching only
 * `fetch` would miss `node:http`, `node:https`, an undici agent obtained
 * directly and anything a library opened for itself. All of them end at one
 * place — `net.Socket.prototype.connect`, which `tls.connect` and `http2` also
 * go through — so that is where this watches, with the `fetch` spy kept beside
 * it because a mocked `fetch` would never reach a socket at all.
 *
 * What an in-process watch cannot see is a **child** process opening its own
 * socket, and the loop spawns several. That half is covered on the record
 * rather than here: the runner observes every host an attempt names, in its
 * commands and its tool inputs, and a caller asserts the attempt's `egress`
 * beside this — the two together are what "nothing went out" rests on.
 */
export function watchOutbound(): { destinations: () => string[] } {
  const asked: string[] = [];
  const connect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: Parameters<Socket["connect"]>
  ) {
    const [first, second] = args;
    asked.push(
      typeof first === "object" && first !== null
        ? JSON.stringify(first)
        : `${String(first)}${typeof second === "string" ? ` ${second}` : ""}`,
    );
    return connect.apply(this, args);
  });
  const fetched = vi.spyOn(globalThis, "fetch");
  return {
    destinations: () => [
      ...asked,
      ...fetched.mock.calls.map((call) => `fetch ${String(call[0])}`),
    ],
  };
}



