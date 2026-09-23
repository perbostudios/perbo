import { Socket } from "node:net";
import { vi } from "vitest";

/** What this process asked to reach while the watch was up. */
export interface OutboundWatch {
  /** Every destination asked for, in the order they were asked for. */
  destinations(): string[];
}

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
 * socket. That half is covered on the record rather than here: the runner
 * observes every host an attempt names, in its commands and its tool inputs,
 * and a caller asserts the attempt's `egress` beside this — the two together
 * are what "nothing went out" rests on.
 *
 * Both spies are the caller's to put back: `vi.restoreAllMocks()` in the test
 * file that started the watch. They are the caller's instance of vitest because
 * this package takes vitest as a peer dependency, and a second instance would
 * hold a registry that the caller's restore never reaches.
 */
export function watchOutbound(): OutboundWatch {
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
