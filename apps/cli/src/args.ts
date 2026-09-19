/**
 * Flag parsing. Hand-rolled and strict: an unrecognised flag is exit 1, not a
 * silently ignored typo that produces a review of something else.
 */

export class UsageError extends Error {}

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
  provider: "anthropic" | "claude-cli" | "codex-cli";
  maxTurns: number | null;
  quiet: boolean;
  /** Where to write the artifact BEFORE redaction, for the corpus harness only. */
  rawArtifact: string | null;
}

const TAKES_VALUE = new Set([
  "--contract",
  "--diff",
  "--checks",
  "--repo",
  "--head",
  "--base",
  "--pr",
  "--outcome",
  "--criterion",
  "--path",
  "--store",
  "--suppressions",
  "--rule-authority",
  "--bundle",
  "--state",
  "--resume",
  "--format",
  "--model",
  "--max-turns",
  "--provider",
  "--raw-artifact",
]);

const FLAGS = new Set(["--json", "--no-color", "--color", "--quiet"]);

export const DEFAULT_STATE_DIR = ".perbo/reviews";

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    contract: null,
    diff: null,
    checks: null,
    repo: ".",
    head: null,
    base: null,
    pr: null,
    outcome: null,
    criteria: [],
    paths: [],
    store: null,
    suppressions: null,
    ruleAuthority: null,
    bundle: null,
    state: DEFAULT_STATE_DIR,
    resume: null,
    format: null,
    json: false,
    color: null,
    model: null,
    provider: "claude-cli",
    maxTurns: null,
    quiet: false,
    rawArtifact: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      throw new UsageError(`unexpected argument '${token}'`);
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);

    if (FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`${name} does not take a value`);
      if (name === "--json") args.json = true;
      if (name === "--no-color") args.color = false;
      if (name === "--color") args.color = true;
      if (name === "--quiet") args.quiet = true;
      continue;
    }
    if (!TAKES_VALUE.has(name)) {
      throw new UsageError(`unknown flag '${name}'`);
    }

    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) throw new UsageError(`${name} requires a value`);

    switch (name) {
      case "--contract":
        args.contract = value;
        break;
      case "--diff":
        args.diff = value;
        break;
      case "--checks":
        args.checks = value;
        break;
      case "--repo":
        args.repo = value;
        break;
      case "--head":
        args.head = value;
        break;
      case "--base":
        args.base = value;
        break;
      case "--pr":
        args.pr = value;
        break;
      case "--outcome":
        args.outcome = value;
        break;
      case "--criterion":
        args.criteria.push(value);
        break;
      case "--path":
        args.paths.push(value);
        break;
      case "--store":
        args.store = value;
        break;
      case "--suppressions":
        args.suppressions = value;
        break;
      case "--rule-authority":
        args.ruleAuthority = value;
        break;
      case "--bundle":
        args.bundle = value;
        break;
      case "--state":
        args.state = value;
        break;
      case "--resume":
        args.resume = value;
        break;
      case "--raw-artifact":
        args.rawArtifact = value;
        break;
      case "--format": {
        const known = REVIEW_FORMATS.find((format) => format === value);
        if (known === undefined) {
          throw new UsageError(
            `--format must be one of ${REVIEW_FORMATS.map((format) => `'${format}'`).join(", ")}`,
          );
        }
        args.format = known;
        break;
      }
      case "--model":
        args.model = value;
        break;
      case "--provider":
        if (
          value !== "anthropic" &&
          value !== "claude-cli" &&
          value !== "codex-cli"
        ) {
          throw new UsageError(
            "--provider must be 'anthropic', 'claude-cli' or 'codex-cli'",
          );
        }
        args.provider = value;
        break;
      case "--max-turns": {
        const turns = Number(value);
        if (!Number.isInteger(turns) || turns < 1) {
          throw new UsageError("--max-turns requires a positive integer");
        }
        args.maxTurns = turns;
        break;
      }
    }
  }

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
