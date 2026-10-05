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
   * that answer (D-137). Only the host is taken: the
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
 * The progress wheel's stages, in the order the loop runs them (D-129): the
 * contract; its execution — the worktree, the executor, sealing and the
 * deterministic checks; the independent review; the refinement that answers
 * its findings; the verification of a refinement round — a closure
 * verification or a later review of the run; and completed, the journey's end
 * waiting on the person. A decision is not a stage: the stage that asked it is
 * shown as waiting on the person. A stage's number is its place here,
 * counting from 1.
 */
export const WHEEL_STEPS = ["contract", "execution", "review", "refinement", "verification", "completed"] as const;
export type WheelStep = (typeof WHEEL_STEPS)[number];
/** A stage's number on the wheel. */
export const wheelStep = (step: WheelStep): number => WHEEL_STEPS.indexOf(step) + 1;
/**
 * How much of the Home ring and the loop's bar a stage fills, from 0 to 1: the
 * stages take equal slices, the contract none and completed the whole.
 */
export const wheelFill = (stage: number): number =>
  Math.min(1, Math.max(0, (stage - 1) / (WHEEL_STEPS.length - 1)));

type Wheel = { stage: number; title: string; state: TicketState };
/** A verification pass as it is said: "Verification", and its number from the second. */
export const verificationWords = (pass: number): string => (pass <= 1 ? "Verification" : `Verification ${pass}`);
const verification = verificationWords;

/**
 * A ticket's stages, oldest first over every run of it, counted as the
 * ticket counts them rather than as each run does (D-129): the runner numbers
 * rounds and reviews within a run, and a run continued after a decision starts
 * them again. The ticket's first review is its review; every later review, a
 * fresh one a continued run takes included, and every closure verification is
 * a verification, numbered over the ticket; refinement rounds are numbered
 * over the ticket too. A run starts at its worktree, and an attempt taken
 * again within one round — a transport retry, a continuation past a ceiling —
 * announces the same round, so it counts once.
 */
export function overTheTicket(stages: readonly RunnerStage[]): RunnerStage[] {
  let reviewed = false;
  let passes = 0;
  let rounds = 0;
  // The last round and pass of the run under way, as the runner numbered them.
  let round: number | null = null;
  let pass: string | null = null;
  return stages.map((stage): RunnerStage => {
    switch (stage.kind) {
      case "worktree":
        round = null;
        pass = null;
        return stage;
      case "remediation":
        if (round !== stage.round) rounds += 1;
        round = stage.round;
        pass = null;
        return { kind: "remediation", round: rounds };
      case "review":
      case "verify": {
        const same = pass === `${stage.kind} ${stage.round}`;
        pass = `${stage.kind} ${stage.round}`;
        if (stage.kind === "review" && !reviewed) {
          reviewed = true;
          return { kind: "review", round: 0 };
        }
        if (!same) passes += 1;
        return { kind: "verify", round: passes };
      }
      default:
        return stage;
    }
  });
}
/**
 * Where a stage puts the progress wheel; a stage with none leaves it where it
 * was. The deterministic checks are part of the execution. A run's first
 * review is the review; each later review of it, and a closure verification,
 * verifies a refinement round and says which pass it is, counted as the
 * runner counts its rounds.
 */
const WHEEL: { [K in RunnerStage["kind"]]?: (stage: Extract<RunnerStage, { kind: K }>) => Wheel } = {
  worktree: () => ({ stage: wheelStep("execution"), title: "Materialising the worktree", state: "provisioning" }),
  executing: () => ({ stage: wheelStep("execution"), title: "Working on the approved outcome", state: "executing" }),
  check: () => ({ stage: wheelStep("execution"), title: "Running deterministic checks", state: "verifying" }),
  review: ({ round }) =>
    round === 0
      ? { stage: wheelStep("review"), title: "Independent review", state: "independent_review" }
      : { stage: wheelStep("verification"), title: verification(round), state: "independent_review" },
  remediation: ({ round }) => ({
    stage: wheelStep("refinement"),
    title: round <= 1 ? "Refining the change" : `Refining the change, round ${round}`,
    state: "executing",
  }),
  verify: ({ round }) => ({ stage: wheelStep("verification"), title: verification(round), state: "independent_review" }),
};

/** Where a run's stages, oldest first, leave the progress wheel: the last of them that moves it, or null where none does. */
export function wheelAt(stages: readonly RunnerStage[]): Wheel | null {
  let current: Wheel | null = null;
  for (const stage of stages) current = (WHEEL[stage.kind] as ((stage: RunnerStage) => Wheel) | undefined)?.(stage) ?? current;
  return current;
}

/**
 * The furthest stage a run's stages took the wheel to, or null where none
 * moves it: the wheel never goes back within a ticket's journey, so a stage
 * the run returns to — a continued run materialising its worktree again, a
 * second refinement round — is said by the title and the steps, never by the
 * wheel (D-129).
 */
export function furthestAt(stages: readonly RunnerStage[]): number | null {
  let furthest: number | null = null;
  for (const stage of stages) {
    const at = (WHEEL[stage.kind] as ((stage: RunnerStage) => Wheel) | undefined)?.(stage)?.stage;
    if (at !== undefined && (furthest === null || at > furthest)) furthest = at;
  }
  return furthest;
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

/** The stages that begin an attempt: its execution, a refinement round, or a round resolving a conflict with the base. */
export const ATTEMPT_STARTS: readonly RunnerStage["kind"][] = ["executing", "remediation", "conflict"];

/**
 * The agents' words out of a run's log, by the attempt each was said in:
 * `before` holds the words said before the first attempt the log saw begin,
 * which are the end of an attempt whose start the log's tail has cut, and
 * `attempts` each attempt the log saw begin, oldest first, with the stage it
 * began on and the words said in it.
 */
export function spokenByAttempt(log: string): {
  before: { speaker: Speaker; words: string }[];
  attempts: { start: RunnerStage; said: { speaker: Speaker; words: string }[] }[];
} {
  const before: { speaker: Speaker; words: string }[] = [];
  const attempts: { start: RunnerStage; said: { speaker: Speaker; words: string }[] }[] = [];
  for (const line of log.split("\n").map((each) => each.trim())) {
    const spoken = readSpoken(line);
    if (spoken !== null) {
      (attempts.at(-1)?.said ?? before).push(spoken);
      continue;
    }
    const stage = readStage(line);
    if (stage !== null && ATTEMPT_STARTS.includes(stage.kind)) attempts.push({ start: stage, said: [] });
  }
  return { before, attempts };
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
