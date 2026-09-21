/**
 * The line `perbo review` is asked for by: which flags it offers, and the
 * combinations of them it refuses.
 *
 * The walk itself is `command-line/grammar.ts`, so an unrecognised flag is
 * exit 1 here as it is everywhere — never a silently ignored typo that
 * produces a review of something else. What is here is what only this command
 * knows: its two enumerations, its turn count, and which of its flags cannot
 * be given together.
 */

import type { ModelProvider } from "@perbo/model";
import {
  listFlag,
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../../../command-line/grammar.js";
import { UsageError } from "../../../usage-error.js";

/**
 * What `--format` accepts. `json` is first because it is the default, and the
 * list is what the refusal names: an unrecognised format is a usage error that
 * says what is on offer, never a silent fall back to JSON — a caller that asked
 * for a comment body and got an artifact would post the artifact.
 */
export const REVIEW_FORMATS = ["json", "markdown"] as const;
export type ReviewFormat = (typeof REVIEW_FORMATS)[number];

/**
 * The value of `--diff` or `--checks` that means "read it from standard input"
 * rather than from a file of that name.
 *
 * One of the two, never both: a CI step that has the diff in a pipe and the
 * check results in a file can pipe the first without writing a temporary file
 * for it, and the other way round — but a process has one standard input, so
 * two flags reading it would each get whichever half of the stream arrived
 * first. That is refused when the flags are parsed, before anything is read or
 * spent.
 */
export const STDIN = "-";

export interface ReviewArgs {
  contract: string | null;
  /** A path, or {@link STDIN} for the diff piped on standard input. */
  diff: string | null;
  /** A path, or {@link STDIN} for the check results piped on standard input. */
  checks: string | null;
  repo: string;
  /**
   * With `--contract`, the head commit the change set is pinned to. With
   * `--base`, the head *ref* of the range being reviewed — the same flag
   * naming the same end of the change, resolved through `git` when there is a
   * range to resolve it against.
   */
  head: string | null;
  /** The other end of the range. Its presence is what makes `--head` a ref. */
  base: string | null;
  /** `owner/repo#N` or its URL: review that pull request, with no ticket. */
  pr: string | null;
  /** The contract as typed. Its presence makes the contract source `arguments`. */
  outcome: string | null;
  criteria: string[];
  /** What the change may touch. Nothing typed means `**`: no scope was stated. */
  paths: string[];
  /** Where the local store lives (default `<repo>/.perbo`). */
  store: string | null;
  suppressions: string | null;
  ruleAuthority: string | null;
  bundle: string | null;
  state: string;
  resume: string | null;
  /**
   * What the verdict is written as. `null` is the default and means JSON: the
   * artifact, as every caller of this command has always read it. `markdown`
   * asks for the pull-request comment body instead (SCP-219). Naming `json`
   * explicitly is the same as leaving it out, except on a terminal, where it
   * asks for the artifact rather than the human rendering — as `--json` does.
   */
  format: ReviewFormat | null;
  json: boolean;
  color: boolean | null;
  model: string | null;
  provider: ModelProvider;
  maxTurns: number | null;
  quiet: boolean;
  /** Where to write the artifact BEFORE redaction, for the corpus harness only. */
  rawArtifact: string | null;
}

export const DEFAULT_STATE_DIR = ".perbo/reviews";

const REVIEW_FLAGS = {
  "--contract": valueFlag(),
  "--diff": valueFlag(),
  "--checks": valueFlag(),
  "--repo": valueFlag(),
  "--head": valueFlag(),
  "--base": valueFlag(),
  "--pr": valueFlag(),
  "--outcome": valueFlag(),
  "--criterion": listFlag(),
  "--path": listFlag(),
  "--store": valueFlag(),
  "--suppressions": valueFlag(),
  "--rule-authority": valueFlag(),
  "--bundle": valueFlag(),
  "--state": valueFlag(),
  "--resume": valueFlag(),
  "--format": valueFlag(),
  "--model": valueFlag(),
  "--max-turns": valueFlag(),
  "--provider": valueFlag(),
  /** The corpus harness's own, so that a scored run can keep what redaction removes. */
  "--raw-artifact": valueFlag({ hidden: true }),
  "--json": switchFlag(),
  "--no-color": switchFlag(),
  "--color": switchFlag(),
  "--quiet": switchFlag(),
} satisfies FlagTable;

export const REVIEW_GRAMMAR: Grammar<typeof REVIEW_FLAGS> = {
  command: "review",
  flags: REVIEW_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal:
      "review takes no positional argument: what it judges is named by a flag, e.g. perbo " +
      "review --contract c.json --diff change.diff",
  },
  afterDoubleDash: "positionals",
};

/** One of the two enumerations the line carries, refused by name rather than fallen back from. */
function readFormat(value: string): ReviewFormat {
  const known = REVIEW_FORMATS.find((format) => format === value);
  if (known === undefined) {
    throw new UsageError(
      `--format must be one of ${REVIEW_FORMATS.map((format) => `'${format}'`).join(", ")}`,
    );
  }
  return known;
}

function readProvider(value: string): ModelProvider {
  if (value !== "anthropic" && value !== "claude-cli" && value !== "codex-cli") {
    throw new UsageError("--provider must be 'anthropic', 'claude-cli' or 'codex-cli'");
  }
  return value;
}

function readMaxTurns(value: string): number {
  const turns = Number(value);
  if (!Number.isInteger(turns) || turns < 1) {
    throw new UsageError("--max-turns requires a positive integer");
  }
  return turns;
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const line = parseArgv(REVIEW_GRAMMAR, argv);
  const format = line.flags["--format"];
  const provider = line.flags["--provider"];
  const maxTurns = line.flags["--max-turns"];
  const args: ReviewArgs = {
    contract: line.flags["--contract"] ?? null,
    diff: line.flags["--diff"] ?? null,
    checks: line.flags["--checks"] ?? null,
    repo: line.flags["--repo"] ?? ".",
    head: line.flags["--head"] ?? null,
    base: line.flags["--base"] ?? null,
    pr: line.flags["--pr"] ?? null,
    outcome: line.flags["--outcome"] ?? null,
    criteria: [...(line.flags["--criterion"] ?? [])],
    paths: [...(line.flags["--path"] ?? [])],
    store: line.flags["--store"] ?? null,
    suppressions: line.flags["--suppressions"] ?? null,
    ruleAuthority: line.flags["--rule-authority"] ?? null,
    bundle: line.flags["--bundle"] ?? null,
    state: line.flags["--state"] ?? DEFAULT_STATE_DIR,
    resume: line.flags["--resume"] ?? null,
    format: format === undefined ? null : readFormat(format),
    json: line.flags["--json"] === true,
    color: line.flags["--color"] === true ? true : line.flags["--no-color"] === true ? false : null,
    model: line.flags["--model"] ?? null,
    provider: provider === undefined ? "claude-cli" : readProvider(provider),
    maxTurns: maxTurns === undefined ? null : readMaxTurns(maxTurns),
    quiet: line.flags["--quiet"] === true,
    rawArtifact: line.flags["--raw-artifact"] ?? null,
  };

  // Before every other rule, because it is the one refusal that has to hold
  // whatever else was asked for: nothing is read from the stream, so nothing is
  // consumed by the run that is about to be refused.
  if (args.diff === STDIN && args.checks === STDIN) {
    throw new UsageError(
      "--diff - and --checks - both read standard input: one of the two may read standard " +
        "input, not both. Pipe one and pass the other as a file.",
    );
  }

  if (args.resume !== null) {
    for (const [flag, value] of [
      ["--contract", args.contract],
      ["--diff", args.diff],
      ["--checks", args.checks],
      ["--pr", args.pr],
      ["--base", args.base],
      ["--outcome", args.outcome],
      ["--criterion", args.criteria.length > 0 ? args.criteria[0]! : null],
    ] as const) {
      if (value !== null) {
        throw new UsageError(`${flag} cannot be combined with --resume: the resumed review has one`);
      }
    }
    return args;
  }

  // A review of something never admitted carries its own contract and its own
  // diff (SCP-179), so the two flags a planned review requires are exactly the
  // two it must not be given. `ticketless.ts` refuses the rest of the bad
  // combinations, where the reason to refuse is about the contract rather than
  // about which flags are present.
  if (isTicketlessArgs(args)) return args;

  if (args.contract === null) throw new UsageError("--contract is required");
  if (args.diff === null) throw new UsageError("--diff is required");
  return args;
}

/** Whether these arguments name a change to review rather than files to read. */
export const isTicketlessArgs = (args: ReviewArgs): boolean =>
  args.pr !== null || args.base !== null || args.outcome !== null || args.criteria.length > 0;
