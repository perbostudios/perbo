import { attemptId as makeAttemptId } from "@perbo/contracts";

/**
 * What one round of a run hands the next.
 *
 * The loop's own state, kept apart from the phases that read it so that a
 * phase can be given a state and asked what it does with it.
 */

/**
 * The id of one attempt of one round.
 *
 * Round 0's first attempt is the run's root, which is what the worktree, the
 * branch and the attempts record are all keyed by, so it keeps that id
 * exactly. Everything after it is minted from the root and the position — the
 * round, the ceiling continuation within it and the transport retry within
 * that — so the same run never mints one id twice and a reader can see from the
 * seed which attempt it is looking at.
 */
export function attemptIdFor(position: {
  root: string;
  round: number;
  transport_retry: number;
  ceiling_continuation: number;
}): string {
  if (position.round === 0 && position.transport_retry === 0 && position.ceiling_continuation === 0) {
    return position.root;
  }
  const seeded = position.ceiling_continuation === 0 ? "" : `|continue|${position.ceiling_continuation}`;
  const retry = position.transport_retry === 0 ? "" : `|transport|${position.transport_retry}`;
  return makeAttemptId(`${position.root}|round|${position.round}${seeded}${retry}`);
}
