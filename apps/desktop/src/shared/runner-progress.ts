import { readSpoken, readTally, type Speaker, type Tally } from "@perbo/contracts/browser";
import type { TicketState } from "@perbo/contracts";

/**
 * A stage the runner announces as it enters it, read from one of its progress
 * lines. Only the stage and the number or check name the line states are
 * taken: a path, a branch, a command or a URL the line also carries is left
 * where it is, so nothing here can become an action's parameter.
 */
export type RunnerStage =
  | { kind: "worktree" }
  | { kind: "executing" }
  /** A remediation round, counting from 1 as the runner does. */
  | { kind: "remediation"; round: number }
  | { kind: "conflict" }
  | { kind: "seal" }
  /** One of the pinned checks over the whole change, by the name it is declared with. */
  | { kind: "check"; name: string }
  /** The loop's own round, counting from 0 as the runner does. */
  | { kind: "review"; round: number }
  | { kind: "verify"; round: number }
  | { kind: "delivery" };

/** The stage one progress line announces, or null for a line that announces none. */
export function readStage(line: string): RunnerStage | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("worktree ")) return { kind: "worktree" };
  if (trimmed === "executing") return { kind: "executing" };
  if (trimmed === "sealing the change set") return { kind: "seal" };
  if (/^resolving the base conflict on \d+ file\(s\)$/.test(trimmed)) return { kind: "conflict" };
  if (/^pull request \S+$/.test(trimmed)) return { kind: "delivery" };
  let match = /^remediation round (\d+) of at most \d+$/.exec(trimmed);
  if (match) return { kind: "remediation", round: Number(match[1]) };
  match = /^check ([^:]+): /.exec(trimmed);
  if (match) return { kind: "check", name: match[1]! };
  match = /^review round (\d+)$/.exec(trimmed);
  if (match) return { kind: "review", round: Number(match[1]) };
  match = /^verifying closures, round (\d+)$/.exec(trimmed);
  if (match) return { kind: "verify", round: Number(match[1]) };
  return null;
}

/** One stage a command's log announced, in the order it printed them. */
export interface LoggedStage {
  stage: RunnerStage;
  /**
   * For a review round, the open findings the runner printed after it — the
   * reviewer's own lines and the runner's `finding:` lines — counted and never
   * read. Zero for every other stage.
   */
  findings: number;
  /** Whether a later stage followed it in the log, so that what it printed after it is all there is. */
  settled: boolean;
}

/** Every stage a command's log announced, oldest first. */
export function runnerStages(log: string): LoggedStage[] {
  const stages: LoggedStage[] = [];
  for (const line of log.split("\n").map((each) => each.trim())) {
    const stage = readStage(line);
    if (stage !== null) {
      const previous = stages.at(-1);
      if (previous !== undefined) previous.settled = true;
      stages.push({ stage, findings: 0, settled: false });
      continue;
    }
    const last = stages.at(-1);
    if (last?.stage.kind !== "review") continue;
    if (readSpoken(line)?.speaker === "reviewer" || line.startsWith("finding: ")) last.findings += 1;
  }
  return stages;
}

/** Where a stage puts the progress wheel; a stage with none leaves it where it was. */
const WHEEL: Partial<Record<RunnerStage["kind"], { stage: number; title: string; state: TicketState }>> = {
  worktree: { stage: 2, title: "Materialising the worktree", state: "provisioning" },
  executing: { stage: 2, title: "Working on the approved outcome", state: "executing" },
  remediation: { stage: 5, title: "Refining the change", state: "executing" },
  check: { stage: 3, title: "Running deterministic checks", state: "verifying" },
  review: { stage: 6, title: "Independent review", state: "independent_review" },
  verify: { stage: 5, title: "Verifying the refinements", state: "independent_review" },
};

/** Observed CLI milestones, used for display while ticket persistence lags and for the stage-change notification. */
export function runnerProgress(
  log: string,
): { stage: number; title: string; state: TicketState } | null {
  let current: { stage: number; title: string; state: TicketState } | null = null;
  for (const { stage } of runnerStages(log)) current = WHEEL[stage.kind] ?? current;
  return current;
}

/**
 * The executor's and the reviewer's own words out of a command's log, in the
 * order it printed them, as words shown and never read as anything else.
 * Nothing else the log holds is taken, so no tool call is.
 */
export function spokenWords(log: string): { speaker: Speaker; words: string }[] {
  return log.split("\n").flatMap((line) => {
    const spoken = readSpoken(line.trim());
    return spoken === null ? [] : [spoken];
  });
}

/**
 * What a run has done so far, from the last tally line its log holds: the
 * runner's own counts and the providers' usage, each over the whole run, so the
 * latest line is the whole of it however much of the log's head was cut. Null
 * where the log holds none. No agent's words and no tool call is read.
 */
export function runnerTally(log: string): Tally | null {
  const lines = log.split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const tally = readTally(lines[at]!.trim());
    if (tally !== null) return tally;
  }
  return null;
}
