/**
 * The pauses before each retry of a reading of the plan against its spec that
 * did not run — no credential, the network, a crash, a print that is not a
 * verdict: it is tried once, and again after each pause, so four tries over
 * about fourteen seconds before the reading fails and the page says so
 * (D-138). Both hosts read it from here.
 */
export const READING_RETRY_PAUSES_MS: readonly number[] = [2_000, 4_000, 8_000];

/**
 * A command whose model provider refused the request Perbo sent: the CLI
 * exited `request_refused` (`EXIT_CODES` in `@perbo/contracts`). The same
 * request is refused again, so nothing runs it again and no sentence offers
 * to. The message is the CLI's own.
 */
export class RefusedRequestError extends Error {}

/**
 * `attempt` tried until it runs: again after each of
 * {@link READING_RETRY_PAUSES_MS} while it throws, and the last failure thrown
 * once none is left. `stopped` ends the retrying early, as a cancelled job
 * does, with the failure it last had, and so does a {@link RefusedRequestError},
 * which another try would meet again.
 */
export async function untilItRuns<T>(
  attempt: () => Promise<T> | T,
  pause: (ms: number) => Promise<void>,
  stopped: () => boolean = () => false,
): Promise<T> {
  let failure: unknown;
  for (const wait of [...READING_RETRY_PAUSES_MS, null]) {
    try {
      return await attempt();
    } catch (error) {
      failure = error;
    }
    if (wait === null || failure instanceof RefusedRequestError || stopped()) break;
    await pause(wait);
    if (stopped()) break;
  }
  throw failure;
}
