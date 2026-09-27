import {
  readEgressQuestion,
  readEgressSettled,
  readSpoken,
  readTally,
  type EgressSettlement,
  type Speaker,
  type Tally,
} from "@perbo/contracts/browser";
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
  | { kind: "delivery" }
  /**
   * The run waiting on a person's answer about a host off the allow-list, and
   * that answer (D-NEW-an-unlisted-host-asks). Only the host is taken: the
   * command the line also carries is the card's to show.
   */
  | { kind: "egress"; host: string }
  | { kind: "egressSettled"; host: string; settled: EgressSettlement };

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
  const asked = readEgressQuestion(trimmed);
  if (asked !== null) return { kind: "egress", host: asked.host };
  const settled = readEgressSettled(trimmed);
  if (settled !== null) return { kind: "egressSettled", host: settled.host, settled: settled.settled };
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

/**
 * The progress wheel's steps, in the order the loop runs them: the contract,
 * its execution, the checks over the change, the independent review, the
 * decisions a review puts to the person, and the refinement that answers the
 * findings. A step's number is its place here, counting from 1.
 */
export const WHEEL_STEPS = ["contract", "execution", "checks", "review", "decisions required", "refinement"] as const;
export type WheelStep = (typeof WHEEL_STEPS)[number];
/** A step's number on the wheel. */
export const wheelStep = (step: WheelStep): number => WHEEL_STEPS.indexOf(step) + 1;

type Wheel = { stage: number; title: string; state: TicketState };
/**
 * Where a stage puts the progress wheel; a stage with none leaves it where it
 * was. A review after a refinement round puts it back at the review, and says
 * which pass it is; a closure verification is the refinement's own.
 */
const WHEEL: { [K in RunnerStage["kind"]]?: (stage: Extract<RunnerStage, { kind: K }>) => Wheel } = {
  worktree: () => ({ stage: wheelStep("execution"), title: "Materialising the worktree", state: "provisioning" }),
  executing: () => ({ stage: wheelStep("execution"), title: "Working on the approved outcome", state: "executing" }),
  check: () => ({ stage: wheelStep("checks"), title: "Running deterministic checks", state: "verifying" }),
  // The runner counts its rounds from 0; a person counts reviews from 1.
  review: ({ round }) => ({
    stage: wheelStep("review"),
    title: round === 0 ? "Independent review" : `Independent review ${round + 1}`,
    state: "independent_review",
  }),
  remediation: () => ({ stage: wheelStep("refinement"), title: "Refining the change", state: "executing" }),
  verify: () => ({ stage: wheelStep("refinement"), title: "Verifying the refinements", state: "independent_review" }),
};

/** Where a run's stages, oldest first, leave the progress wheel: the last of them that moves it, or null where none does. */
export function wheelAt(stages: readonly RunnerStage[]): Wheel | null {
  let current: Wheel | null = null;
  for (const stage of stages) current = (WHEEL[stage.kind] as ((stage: RunnerStage) => Wheel) | undefined)?.(stage) ?? current;
  return current;
}

/** Observed CLI milestones, used for display while ticket persistence lags and for the stage-change notification. */
export function runnerProgress(log: string): Wheel | null {
  return wheelAt(runnerStages(log).map(({ stage }) => stage));
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
