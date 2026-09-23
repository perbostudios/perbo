import { AYO_BRANCH_PREFIX, BRANCH_PREFIX, CommandFailedError, git } from "@perbo/workspace";
import type { MergedTicketContext } from "@perbo/runner";
import { listTickets, readContract } from "../../../store/tickets.js";

/**
 * What merged into the base under a branch, as the store knows it (SCP-227).
 *
 * The reconciliation round is briefed with the approved contracts of the
 * tickets whose merges the branch now has to be made level with — what a
 * person resolving the conflict would read first. Which tickets those are is
 * read from the base's own history between the branch's merge-base and the
 * base's tip, and only from the shapes the loop itself writes: the runner's
 * merge subject (`<KEY>: merge <branch> into <base>`) and the attempt-branch
 * namespaces (`prb/<KEY>/<slug>` and `ayo/<KEY>/<slug>`), which a person's
 * merge of the loop's pull request names in its subject. Nothing a model wrote
 * is read.
 *
 * Both reads go through `@perbo/workspace`'s repository module, which is where
 * every git process Perbo starts is decided: argv only, the runner's
 * environment, a bounded wait, and a log that arrived cut refused rather than
 * read as the history.
 */

const TIMEOUT_MS = 120_000;
/** What a base's history between two commits may say, past which the read is refused rather than trusted. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const KEY = "[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}";
const RUNNER_MERGE = new RegExp(`^(${KEY}): merge `, "m");
const ATTEMPT_BRANCH = new RegExp(`\\b(?:${BRANCH_PREFIX}|${AYO_BRANCH_PREFIX})/(${KEY})/`, "g");

/** The ticket keys the base's history names between `from` and `to`, in first-seen order. */
export async function ticketKeysMergedBetween(args: {
  repository_root: string;
  from: string;
  to: string;
}): Promise<string[]> {
  // Oldest first: the brief reads what landed in the order it landed.
  const log = await git.run(
    args.repository_root,
    ["log", "--reverse", "--format=%s%n%b%n--", `${args.from}..${args.to}`],
    { timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_LOG_BYTES },
  );
  if (log.code !== 0) return [];
  // A log longer than the read holds arrives as its tail, which is shaped
  // exactly like the whole of one and is short by the merges before the cut.
  // Those are tickets the round would be briefed on, so a cut log names none.
  if (log.truncated) return [];
  const keys: string[] = [];
  const note = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  for (const message of log.stdout.split("\n--\n")) {
    const subject = RUNNER_MERGE.exec(message);
    if (subject !== null) note(subject[1]!);
    for (const match of message.matchAll(ATTEMPT_BRANCH)) note(match[1]!);
  }
  return keys;
}

/**
 * The approved contracts of the tickets that merged into `base_ref` since the
 * branch's merge-base with it. A key the history names that the store does
 * not hold — another repository's ticket, a branch a person named by hand —
 * is left out: there is no contract to brief with.
 */
export async function mergedTicketContext(args: {
  dir: string;
  repository_root: string;
  base_ref: string;
  branch: string;
  /** The ticket whose branch this is, never its own context. */
  except: string;
}): Promise<MergedTicketContext[]> {
  let base: string | null;
  try {
    base = await git.mergeBase(args.repository_root, args.base_ref, args.branch, {
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    // A read that did not finish says nothing about where the branch diverged.
    if (!(error instanceof CommandFailedError)) throw error;
    base = null;
  }
  if (base === null) return [];
  const keys = await ticketKeysMergedBetween({
    repository_root: args.repository_root,
    from: base,
    to: args.base_ref,
  });
  const byKey = new Map(listTickets(args.dir).map((ticket) => [ticket.key, ticket]));
  const context: MergedTicketContext[] = [];
  for (const key of keys) {
    if (key === args.except || !byKey.has(key)) continue;
    let contract;
    try {
      contract = readContract(args.dir, key);
    } catch {
      continue;
    }
    context.push({
      ticket_key: key,
      outcome: contract.outcome,
      criteria:
        contract.level === "P0"
          ? []
          : contract.acceptance_criteria.map(
              (criterion) => `${criterion.text} :: ${criterion.expected_verification.assertion}`,
            ),
      paths_allowed: [...contract.scope.paths_allowed],
    });
  }
  return context;
}
