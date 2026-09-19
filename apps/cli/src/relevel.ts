import { AYO_BRANCH_PREFIX, BRANCH_PREFIX, gitEnv, run } from "@perbo/workspace";
import type { MergedTicketContext } from "@perbo/runner";
import { listTickets, readContract } from "./tickets.js";

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
 */

const TIMEOUT_MS = 120_000;
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
  const log = await run(["git", "log", "--reverse", "--format=%s%n%b%n--", `${args.from}..${args.to}`], {
    cwd: args.repository_root,
    env: gitEnv(),
    timeoutMs: TIMEOUT_MS,
  });
  if (log.code !== 0) return [];
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
  const options = { cwd: args.repository_root, env: gitEnv(), timeoutMs: TIMEOUT_MS };
  const base = await run(["git", "merge-base", args.base_ref, args.branch], options);
  if (base.code !== 0) return [];
  const keys = await ticketKeysMergedBetween({
    repository_root: args.repository_root,
    from: base.stdout.trim(),
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
