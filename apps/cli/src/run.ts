import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CheckResultsFileSchema,
  EXIT_CODES,
  LimitExceededError,
  PlanContractSchema,
  exitCodeForDecision,
  hasAcceptanceCriteria,
  wholeChangeChecks,
  type CheckResult,
  type PlanContract,
  type ReviewRouting,
  type PlanContractWithCriteria,
  type ReviewArtifact,
} from "@perbo/contracts";
import {
  PlanNotReviewableError,
  RuleAuthorityFileSchema,
  SuppressionFileSchema,
  anthropicModel,
  buildRuleAuthority,
  claudeCliModel,
  codexCliModel,
  buildSuppressions,
  redactCredentials,
  redactReviewArtifact,
  reviewGraph,
  runReview,
  verdictSchemas,
  type ReviewModel,
} from "@perbo/review";
import {
  AgentConfigurationPresentError,
  DeliveryError,
  ResumeRefusedError,
  RunRefusedError,
  preflight,
  renderPreflight,
  type PreflightRequest,
  type PreflightResult,
} from "@perbo/runner";
import { CommandFailedError, WorkspaceError } from "@perbo/workspace";
import { STDIN, UsageError, isTicketlessArgs, type ReviewArgs } from "./args.js";
import { renderReviewMarkdown } from "./markdown.js";
import { renderArtifact } from "./render.js";
import {
  assertTicketlessArgs,
  buildTicketlessBundle,
  resolveTicketlessSource,
  reviewsDir,
  routingFor,
  statesCriteria,
  writeTicketlessBundle,
  type TicketlessSource,
} from "./ticketless.js";
import {
  contractForUnresolved,
  loadResumeRecord,
  mergeResumed,
  saveResumeRecord,
  type ResumeRecord,
} from "./resume.js";

function readPackageVersion(): string {
  const packagePath = new URL("../package.json", import.meta.url);
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read CLI package metadata from ${packagePath.pathname}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    metadata.version.length === 0
  ) {
    throw new Error(`CLI package metadata at ${packagePath.pathname} has no version`);
  }
  return metadata.version;
}

export const VERSION = readPackageVersion();

export interface Streams {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  isTTY: boolean;
}

export interface RunOptions {
  args: ReviewArgs;
  streams: Streams;
  cwd: string;
  now: Date;
  /** Injected by the tests. Production builds the selected transport. */
  makeModel?: (submitSchema: Record<string, unknown>, modelId: string | null) => ReviewModel;
  /**
   * Injected by the tests. Production checks the real machine — but only when
   * the model is the real one too: an injected model has no binary or key to
   * look for.
   */
  preflight?: (request: PreflightRequest) => PreflightResult;
  /**
   * The `gh` a ticketless review reads a pull request with. Production leaves
   * it unset and the one on PATH is used; a test names a binary instead, so
   * that pointing this command at a different `gh` does not mean editing the
   * environment of the whole process.
   */
  gh?: { binary?: string | undefined } | undefined;
  /**
   * Standard input, whole, for `--diff -` or `--checks -`. Injected by the
   * tests; production reads this process's own file descriptor 0.
   */
  stdin?: () => string;
}

/**
 * Everything on standard input, read once.
 *
 * A terminal is refused rather than read: `--diff -` on an interactive shell
 * with nothing piped in would otherwise sit there holding the line open, and a
 * command that appears to hang is a worse answer than one that says what it
 * wanted.
 */
function readStandardInput(flag: string): string {
  if (process.stdin.isTTY) {
    throw new UsageError(
      `${flag} - reads standard input, and standard input here is a terminal: pipe it in ` +
        `(\`… | perbo review ${flag} -\`), or name a file.`,
    );
  }
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    throw new UsageError(
      `could not read ${flag} - from standard input: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Standard input for the one flag that asked for it, refused when it is empty.
 *
 * A pipe that produced nothing — a `git diff` of an empty range, a check step
 * that wrote no file — is the failure worth catching here, because the review
 * that followed it would be a reviewer asked to judge a change it was never
 * shown, and paid for. Nothing is spent on it: this runs before the model is
 * built.
 */
function readPiped(flag: "--diff" | "--checks", options: RunOptions, empty: string): string {
  const text = (options.stdin ?? (() => readStandardInput(flag)))();
  if (text.trim() === "") throw new UsageError(`${flag} - read nothing from standard input: ${empty}`);
  return text;
}

/**
 * What a refused run says: what was found, and what to run about it.
 *
 * The findings are the diagnostic's own, printed one to a line with the reason
 * that names them and the detail that explains them — which is also where a
 * finding states its fix, so nothing here has to restate one. Then the command
 * that answers the whole question against this repository, because the finding
 * on its own tells a person what is wrong and not how to see the rest of it.
 */
function refusalReport(noun: string, error: RunRefusedError): string {
  const found = error.findings.map((finding) => `\n  ${finding.reason} — ${finding.detail}`).join("");
  return (
    `${noun} did not start: ${error.message}.${found}\n` +
    `Nothing was executed. \`perbo doctor --repo ${error.repository_root}\` reports the whole ` +
    "diagnostic."
  );
}

/**
 * One sentence per failure class, with the fix where one is known. A stack
 * trace is kept only for an error nothing here recognises, because a partner
 * reading "the review did not complete: Error: spawn claude ENOENT" followed
 * by twelve frames is being handed a debugging session instead of an answer.
 */
export function describeFailure(command: string, error: unknown): { message: string; code: number } {
  const noun =
    command === "review" ? "the review" : command === "run" ? "the run" : `\`perbo ${command}\``;
  const code = EXIT_CODES.did_not_complete;
  if (error instanceof RunRefusedError) return { message: refusalReport(noun, error), code };
  if (error instanceof LimitExceededError) {
    const raise =
      error.reason === "limit_exceeded" && error.resource
        ? ` Raise limits.limits.${error.resource} in .perbo/config.json to allow it.`
        : " Clear the kill switch in the limits table to allow it.";
    return { message: `${noun} was refused by a limit: ${error.message}.${raise}`, code };
  }
  if (error instanceof WorkspaceError) {
    return {
      message: `${noun} could not prepare a worktree (${error.reason}): ${error.message}. Run \`perbo doctor --repo .\` for the specific reason.`,
      code,
    };
  }
  if (error instanceof DeliveryError) {
    return { message: `${noun} could not publish: ${error.message} — ${error.detail}.`, code };
  }
  if (error instanceof ResumeRefusedError) {
    return {
      message:
        `${noun} could not resume from ${error.bundle_id}: ${error.message}. Nothing was ` +
        "executed and the bundle is untouched; run the ticket without --resume-from to start " +
        "from the base commit instead.",
      code,
    };
  }
  if (error instanceof AgentConfigurationPresentError) {
    return {
      message:
        `${noun} stopped because ${error.message}. The attempt is recorded; nothing was ` +
        "reviewed. Remove the configuration the agent loaded, or report which path it named.",
      code,
    };
  }
  // A command the run started and could not finish. The error already carries
  // the argv, the exit code and what the command wrote; all that was missing is
  // that they reached the person, so this branch prints them and drops the
  // frames. It is not the seal's own: every command a run starts — the install,
  // the checks, the push — fails the same way and says why the same way.
  if (error instanceof CommandFailedError) {
    return { message: `${noun} stopped on a command that failed: ${error.message}`, code };
  }
  const failure = error as { code?: unknown; path?: unknown; syscall?: unknown };
  if (error instanceof Error && failure.code === "ENOENT" && typeof failure.syscall === "string" && failure.syscall.startsWith("spawn")) {
    const binary = typeof failure.path === "string" ? failure.path : failure.syscall.replace(/^spawn\s*/, "") || "a binary";
    const fix =
      binary === "claude"
        ? "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`"
        : binary === "gh"
          ? "install the GitHub CLI (https://cli.github.com) and run `gh auth login`"
          : binary === "git"
            ? "install git (https://git-scm.com)"
            : `install \`${binary}\` and make sure it is on PATH`;
    return { message: `${noun} needs \`${binary}\`, which is not on PATH: ${fix}.`, code };
  }
  return {
    message: `${noun} did not complete: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    code,
  };
}

/** What a person can do about a reviewer that could not be reached. */
function providerUnavailableHint(provider: ReviewArgs["provider"]): string {
  switch (provider) {
    case "anthropic":
      return "the reviewer could not reach the Anthropic API: check that ANTHROPIC_API_KEY is set and valid, and that the network is up, then re-run";
    case "claude-cli":
      return "the `claude` binary could not complete the review: sign in with `claude` (or `claude auth login`) and re-run; `--provider anthropic` reviews on ANTHROPIC_API_KEY instead";
    case "codex-cli":
      return "the `codex` binary could not complete the review: sign in with `codex` and re-run, or use `--provider claude-cli`";
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read ${label} from ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function parseContract(path: string): PlanContract {
  const parsed = PlanContractSchema.safeParse(readJson(path, "the plan contract"));
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a valid PlanContract:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

/** The check results, from wherever they were read. `where` names that source. */
function parseChecks(text: string, where: string): CheckResult[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `could not read the check results from ${where}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  const parsed = CheckResultsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(
      `${where} is not a valid CheckResult list: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function loadChecks(path: string | null): CheckResult[] {
  if (path === null) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(
      `could not read the check results from ${path}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  return parseChecks(text, path);
}

/**
 * Emit the artifact and the exit code, whatever the outcome. Every caller
 * hands this the redacted artifact (D-063): stdout is a write like any other.
 */
function emit(
  artifact: ReviewArtifact,
  contract: PlanContract,
  options: RunOptions,
  resumeCommand: string | null,
  ticketless?: { source: TicketlessSource; routing: ReviewRouting; bundle: unknown } | null,
): number {
  // SCP-219: the pull-request comment body. It is written from the artifact and
  // from nothing else — not the bundle a ticketless review emits below, which
  // carries the contract its source stated, and not the diff. A comment is
  // posted where the change is already on screen; what it adds is the verdict.
  if (options.args.format === "markdown") {
    options.streams.stdout(`${renderReviewMarkdown(artifact)}\n`);
    return exitCodeForDecision(artifact.decision);
  }
  const asJson = options.args.format === "json" || options.args.json || !options.streams.isTTY;
  if (asJson) {
    // A ticketless review's document is the bundle: it carries the artifact
    // whole, and also the contract it was judged against and where the change
    // goes next, neither of which the artifact has anywhere to put.
    options.streams.stdout(
      `${JSON.stringify(ticketless ? ticketless.bundle : artifact, null, 2)}\n`,
    );
  } else {
    const color =
      options.args.color ?? (options.streams.isTTY && process.env.NO_COLOR === undefined);
    options.streams.stdout(
      `${renderArtifact(artifact, contract, {
        color,
        version: VERSION,
        resumeCommand,
        ...(ticketless
          ? { sourceContract: ticketless.source.contract, routing: ticketless.routing }
          : {}),
      })}\n`,
    );
  }
  return exitCodeForDecision(artifact.decision);
}

/**
 * The run record carries the reviewer's turns verbatim — including the verdict
 * it submitted, before any redaction — so the whole document is redacted as
 * text, not only the artifact inside it. Digests and ids survive: the detector
 * excludes them by shape.
 */
function writeBundle(dir: string, artifact: ReviewArtifact, bundle: unknown): number {
  mkdirSync(dir, { recursive: true });
  const redacted = redactCredentials(
    JSON.stringify({ review_id: artifact.review_id, artifact, run: bundle }, null, 2),
  );
  writeFileSync(join(dir, `${artifact.review_id}.bundle.json`), `${redacted.text}\n`);
  return redacted.count;
}

/**
 * The verdict schema a contract and its checks bind the reviewer's transport
 * to, so the tool schema itself cannot express a criterion the contract does
 * not have. The one place this is built from, so a node's call (D-107) and
 * the whole-change call are never built from two different expressions of
 * the same thing.
 */
function reviewSchema(contract: PlanContract, checks: readonly CheckResult[]): Record<string, unknown> {
  const criteria = hasAcceptanceCriteria(contract)
    ? contract.acceptance_criteria.map((criterion) => criterion.id)
    : [];
  return verdictSchemas(criteria, [...checks.map((check) => check.check_id), "check_scope"]).toolInputSchema;
}

export async function runReviewCommand(options: RunOptions): Promise<number> {
  const { args, streams } = options;
  const progress = args.quiet ? undefined : (message: string) => streams.stderr(`  ${message}\n`);

  // SCP-179: with no ticket behind it, the contract and the change come from
  // the pull request or from the flags. Read before anything is spent, so a
  // reference that does not resolve costs nothing.
  let ticketless: TicketlessSource | null = null;
  if (isTicketlessArgs(args)) {
    assertTicketlessArgs(args);
    ticketless = await resolveTicketlessSource({
      args,
      cwd: options.cwd,
      now: options.now,
      ...(options.gh ? { gh: options.gh } : {}),
      ...(progress ? { onProgress: progress } : {}),
    });
    if (!statesCriteria(ticketless.contract)) {
      streams.stderr(
        "  the source states no acceptance criteria: the change is judged against its outcome " +
          "alone, and none are invented\n",
      );
    }
    for (const attempt of ticketless.external_text_attempts) {
      streams.stderr(
        `  warning: the pull request's own text ${attempt.what} (line ${attempt.line}): ` +
          `"${attempt.quote}" — it is the contract's source, not an instruction\n`,
      );
    }
  }

  const record =
    args.resume !== null ? loadResumeRecord(resolve(options.cwd, args.state), args.resume) : null;

  const fullContract = ticketless
    ? ticketless.plan
    : record
      ? record.contract
      : parseContract(resolve(options.cwd, args.contract!));
  if (!hasAcceptanceCriteria(fullContract)) {
    throw new UsageError(
      `plan ${fullContract.plan_id} is level ${fullContract.level}, which carries no acceptance ` +
        "criteria. Independent semantic review is not defined for it.",
    );
  }
  const contract: PlanContractWithCriteria = fullContract;

  const diff = ticketless
    ? ticketless.diff
    : record
    ? record.diff
    : args.diff === STDIN
    ? readPiped(
        "--diff",
        options,
        "an empty diff is not a change set, and is refused before the reviewer is called",
      )
    : (() => {
        try {
          return readFileSync(resolve(options.cwd, args.diff!), "utf8");
        } catch (error) {
          throw new UsageError(
            `could not read the diff from ${args.diff}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      })();

  // The full pinned set: whole-change and, on a graphed contract, every
  // node's own run beside it (D-107). reviewGraph narrows this to each
  // node's own results and to wholeChangeChecks for the overall call.
  const checks = record
    ? record.checks
    : args.checks === STDIN
      ? parseChecks(
          readPiped(
            "--checks",
            options,
            "empty check results are refused before the reviewer is called; leave --checks off " +
              "where a run had none",
          ),
          "standard input",
        )
      : loadChecks(args.checks ? resolve(options.cwd, args.checks) : null);
  const repo = record ? record.repo : resolve(options.cwd, args.repo);
  // A ticketless review pins the head to the commit the source named, so the
  // artifact records the commit that was reviewed rather than a digest of a
  // diff — which is what makes `--pr` reproducible at all.
  const head = ticketless ? ticketless.target.head_commit : record ? record.head_commit : args.head;

  const suppressions = args.suppressions
    ? buildSuppressions(
        SuppressionFileSchema.parse(readJson(resolve(options.cwd, args.suppressions), "suppressions")),
        options.now,
      )
    : undefined;
  if (suppressions) {
    for (const { waiver, reason } of suppressions.rejected) {
      streams.stderr(`  warning: waiver on ${waiver.rule_id} not applied — ${reason}\n`);
    }
  }

  const ruleAuthority = args.ruleAuthority
    ? buildRuleAuthority(
        RuleAuthorityFileSchema.parse(readJson(resolve(options.cwd, args.ruleAuthority), "rule authority")),
      )
    : undefined;

  // On a resume, only the criteria the earlier review never reached are re-run.
  const reviewedContract: PlanContract = record
    ? contractForUnresolved(contract, record.unresolved)
    : contract;

  const makeModel =
    options.makeModel ??
    ((submitSchema, modelId) =>
      args.provider === "claude-cli"
        ? claudeCliModel({ submitSchema, ...(modelId ? { modelId } : {}) })
        : args.provider === "codex-cli"
          ? codexCliModel({ submitSchema, ...(modelId ? { modelId } : {}) })
        : anthropicModel({ submitSchema, ...(modelId ? { modelId } : {}) }));

  // The submit schema is built from the criteria this review is judging and
  // wholeChangeChecks(checks) — the same narrowing reviewGraph applies to a
  // flat contract's one call — so a verdict cannot name a criterion or a
  // check that is not there, a stray node tag included.
  const schema = reviewSchema(reviewedContract, wholeChangeChecks(checks));

  // A missing binary or credential is reported before anything is read or
  // spent, with its fix, rather than as an outage half-way through.
  const check = options.preflight ?? (options.makeModel ? null : preflight);
  if (check) {
    const result = check({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: args.provider,
      needsGh: false,
      needsGit: false,
    });
    if (!result.ok) {
      streams.stderr(`error: the review cannot start on this machine\n${renderPreflight(result)}\n`);
      return EXIT_CODES.did_not_complete;
    }
  }

  let graphOutcome;
  try {
    // D-107: reviewed once per node of reviewedContract's graph, and once
    // over the whole change; a flat contract reviews exactly as runReview
    // alone always has. No per-node artifact is written by this command.
    graphOutcome = await reviewGraph(
      {
        contract: reviewedContract,
        diff,
        checks,
        repoDir: repo,
        model: makeModel(schema, args.model),
        head_commit: head ?? undefined,
        suppressions,
        ruleAuthority,
        now: options.now,
        ...(args.maxTurns !== null ? { maxTurns: args.maxTurns } : {}),
        ...(progress ? { onProgress: progress } : {}),
      },
      runReview,
      { modelFor: (nodeContract, nodeChecks) => makeModel(reviewSchema(nodeContract, nodeChecks), args.model) },
    );
  } catch (error) {
    if (error instanceof PlanNotReviewableError) throw new UsageError(error.message);
    throw error;
  }
  const outcome = graphOutcome.overall;

  const allCriteria = contract.acceptance_criteria.map((criterion) => criterion.id);
  const artifact = record
    ? mergeResumed(record, graphOutcome.combined, allCriteria)
    : graphOutcome.combined;

  // The one deliberate exception to redaction: the corpus harness asks for the
  // artifact as the reviewer produced it, in a file it names, because the
  // D-063 control measures whether redaction *fired* — and it can only tell
  // "never cited" from "cited and redacted" by seeing both. Never stdout.
  if (args.rawArtifact) {
    const rawPath = resolve(options.cwd, args.rawArtifact);
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  // D-063: everything that leaves this process — stdout, the bundle, the
  // resume record — carries the redacted artifact. The reviewer's own output
  // is not persisted anywhere by this command.
  const { artifact: redacted, redactions } = redactReviewArtifact(artifact);
  if (redactions.count > 0) {
    streams.stderr(
      `  redacted ${redactions.count} credential-shaped value(s) from the artifact ` +
        `(${redactions.rules.join(", ")})\n`,
    );
  }

  if (args.bundle) {
    const count = writeBundle(resolve(options.cwd, args.bundle), redacted, outcome.bundle);
    if (count > 0) {
      streams.stderr(`  redacted ${count} credential-shaped value(s) from the run record\n`);
    }
  }

  // SCP-179: the ticketless review's own record. Written for every verdict the
  // reviewer returned — the ones that closed the gate, the one that ran out of
  // turns and the one that was rejected included — because a verdict that only
  // exists on a terminal that has since been closed is not a record of
  // anything. A run that never reached a verdict writes nothing here: a
  // preflight that refuses the machine has returned above, and a failure inside
  // the review leaves through `describeFailure`. There is no review to record
  // in either case. It goes to the repository's `.perbo/` and nowhere else.
  let ticketlessOutcome: {
    source: TicketlessSource;
    routing: ReviewRouting;
    bundle: unknown;
  } | null = null;
  if (ticketless) {
    const routing = routingFor(redacted);
    const bundle = buildTicketlessBundle({
      source: ticketless,
      artifact: redacted,
      routing,
      run: outcome.bundle,
    });
    const written = writeTicketlessBundle(reviewsDir(options.cwd, args), bundle);
    if (written.redactions > 0) {
      streams.stderr(
        `  redacted ${written.redactions} credential-shaped value(s) from the review bundle\n`,
      );
    }
    streams.stderr(`  review written to ${written.path}\n`);
    ticketlessOutcome = { source: ticketless, routing, bundle };
  }

  // Every verdict the reviewer returned was one the plan could not accept, the
  // correction included. There is no partial review to resume — no criterion
  // was ever answered — and the exit code stays the one this command has always
  // given for a verdict it refused: the review did not happen.
  if (redacted.error?.kind === "verdict_rejected") {
    for (const rejected of redacted.rejected_verdicts) {
      streams.stderr(`error: verdict ${rejected.attempt} rejected — ${rejected.reason}\n`);
    }
    emit(redacted, contract, options, null, ticketlessOutcome);
    return EXIT_CODES.usage_or_input_error;
  }

  // Only an unfinished review leaves state behind — and not one the provider
  // could not be reached for: a resume would fail the same way, and what the
  // person needs is the credential or the binary, named.
  let resumeCommand: string | null = null;
  if (redacted.decision === "error" && redacted.error?.kind === "provider_unavailable") {
    streams.stderr(`error: ${providerUnavailableHint(args.provider)}\n`);
  } else if (redacted.decision === "error" || redacted.decision === "incomplete") {
    const unresolved = redacted.coverage
      .filter((entry) => entry.status === "cannot_determine")
      .map((entry) => entry.criterion_id);
    if (unresolved.length > 0) {
      const next: ResumeRecord = {
        review_id: redacted.review_id,
        saved_at: options.now.toISOString(),
        contract,
        diff,
        checks,
        repo,
        head_commit: head ?? null,
        resolved_coverage: redacted.coverage.filter((entry) => entry.status !== "cannot_determine"),
        resolved_findings: redacted.findings,
        unresolved,
        cost_micros: redacted.cost_micros,
        cost_basis: redacted.model.cost_basis,
        model_usage: {
          input_tokens: redacted.model.input_tokens,
          cache_read_input_tokens: redacted.model.cache_read_input_tokens,
          cache_creation_input_tokens: redacted.model.cache_creation_input_tokens,
          output_tokens: redacted.model.output_tokens,
        },
        latency_ms: redacted.latency_ms,
      };
      const path = saveResumeRecord(resolve(options.cwd, args.state), next);
      streams.stderr(`  unfinished review saved to ${path}\n`);
      resumeCommand = `perbo review --resume ${redacted.review_id}`;
    }
  }

  return emit(redacted, contract, options, resumeCommand, ticketlessOutcome);
}
