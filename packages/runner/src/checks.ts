import { basename, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import {
  CheckResultSchema,
  type CheckKind,
  type CheckNode,
  type CheckResult,
  type CheckStatus,
  type PlanNode,
  type SecretIndex,
} from "@perbo/contracts";
import { run } from "@perbo/workspace";
import {
  parseTestOutput,
  planNodeRun,
  planRerun,
  resolveFailures,
  type FailingTest,
  type RerunStep,
  type ResolvedFailure,
  type TestOutput,
} from "./rerun.js";
import { hostTemporaryEnvironment } from "./scratch.js";

/**
 * The pinned check set (D-045, docs/08 item 7).
 *
 * The set that judges an attempt is fixed **before** the attempt starts and is
 * immutable while it runs, so the agent cannot narrow the thing grading it
 * mid-run. It is declared beside the plan rather than inside it, because the P1
 * contract is exactly `outcome`, `acceptance_criteria`, `scope` and `base` and
 * adding a fifth field to it would undo the thing that makes it a contract.
 *
 * The commands are argv and come from the declaration. Nothing the agent
 * produces reaches them.
 */

export const PinnedCheckSchema = z.strictObject({
  check_id: z.string().regex(/^check_[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/),
  name: z.string().min(1),
  kind: CheckResultSchema.shape.kind,
  command: z.array(z.string().min(1)).min(1),
  timeout_ms: z.number().int().min(1000).default(900_000),
  /** A path in the repository that this check's definition lives in, if any. */
  definition_path: z.string().min(1).nullable().default(null),
  /**
   * Where the check came from. `configured` is the repository's own
   * `.perbo/config.json`; `proposed` is derived from the scripts
   * `package.json` declares, for a repository that has no such file yet
   * (SCP-259). The record says which, because a check nobody agreed in a file
   * is a different fact about the run from one somebody did.
   */
  origin: z.enum(["configured", "proposed"]).default("configured"),
});
export type PinnedCheck = z.infer<typeof PinnedCheckSchema>;

/**
 * Running a check uncached (SCP-237).
 *
 * turbo answers a task from its cache whenever the inputs the package declares
 * are unchanged. A suite that reads anything else — the repository's committed
 * tree, a file a sibling package owns — is outside that hash, so a second run
 * over a tree that has since broken is a cache hit: turbo replays the first
 * run's logs and its exit code, and the check is reported passed without ever
 * having run on the tree it is judging.
 *
 * Two controls, because each one is blind where the other sees.
 *
 * The variable covers a turbo the runner cannot see: a check whose argv is
 * `pnpm run test` reaches turbo through a package script, and so does anything
 * a script it calls does in turn. No inspection of the argv finds those.
 *
 * The flag covers a turbo the variable does not reach: a command that composes
 * its own environment before it runs — a wrapper script, a loader, anything
 * that clears what it inherited — arrives at turbo without the variable, and a
 * turbo old enough not to read it arrives without it either way. The argv, in
 * those cases, is the only thing that travels.
 *
 * Set unconditionally, over whatever the caller's environment already said: a
 * check that reads the cache is a check that measured nothing, and there is no
 * arrangement of this repository in which that is the wanted answer.
 */

/** The variable turbo reads as `--force`. */
export const TURBO_FORCE_ENV = "TURBO_FORCE";

/** The flag it means. */
export const TURBO_FORCE_FLAG = "--force";

/**
 * The words a package manager puts in front of a binary it runs out of the
 * workspace. A token that is not one of these before `turbo` means the program
 * is something else, and what that something does with its arguments is not
 * for this to guess.
 */
const TURBO_LAUNCHERS: ReadonlySet<string> = new Set([
  "pnpm",
  "pnpx",
  "npm",
  "npx",
  "yarn",
  "bun",
  "bunx",
  "exec",
  "dlx",
  "x",
  "-s",
  "--silent",
]);

/** Where `turbo run` starts in this argv, or `null` if the command is not one. */
function turboRunAt(command: readonly string[]): number | null {
  const at = command.findIndex((token) => basename(token) === "turbo");
  if (at === -1 || command[at + 1] !== "run") return null;
  return command.slice(0, at).every((token) => TURBO_LAUNCHERS.has(token)) ? at : null;
}

/** Whether this argv runs turbo and does not already say `--force`. */
export function runsTurboWithoutForce(command: readonly string[]): boolean {
  const at = turboRunAt(command);
  if (at === null) return false;
  return !command
    .slice(at)
    .some((token) => token === TURBO_FORCE_FLAG || token.startsWith(`${TURBO_FORCE_FLAG}=`));
}

/**
 * The same argv with `--force` on it, or unchanged where it runs no turbo or
 * already says so.
 *
 * Placed ahead of a bare `--`, because everything past that separator is handed
 * to the task turbo runs: a flag appended after it would reach the test runner
 * instead of turbo, where it means something else or nothing at all.
 */
export function withTurboForce(command: readonly string[]): string[] {
  if (!runsTurboWithoutForce(command)) return [...command];
  const separator = command.indexOf("--");
  const at = separator === -1 ? command.length : separator;
  return [...command.slice(0, at), TURBO_FORCE_FLAG, ...command.slice(at)];
}

/** The same environment with `TURBO_FORCE` set, whatever it said before. */
export function turboForceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [TURBO_FORCE_ENV]: "true" };
}

/** ANSI colour, which a test runner writes and a stored summary should not keep. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * How much of a check's output the record keeps.
 *
 * The tail of a build tool's log is its own exit line, so a record capped to
 * the tail alone says a command failed and nothing about what failed in it.
 * The cap therefore budgets two parts: the tail of the raw output, and the
 * failure lines the runner parsed out of it, which are appended last so they
 * survive the cut.
 */
export const CHECK_DETAIL_MAX_CHARS = 8_000;
/** The share of that budget the parsed failure lines may take. */
export const CHECK_EVIDENCE_MAX_CHARS = 3_000;

/**
 * Summarise a check run for a human, from the tail of its own output.
 *
 * A summary is not a status: the exit code decides `passed` or `failed`, and
 * this only decides what the line says beside it.
 */
function summarise(stdout: string, stderr: string, code: number | null): string {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => line.length > 0);
  const interesting = lines
    .reverse()
    .find((line) => /\b(passed|failed|error|errors|tests?|files?)\b/i.test(line));
  return interesting?.slice(0, 120) ?? `exited ${code ?? "unknown"}`;
}

/** The exit code decides the status; a run that never finished measured nothing. */
function statusOf(result: { timed_out: boolean; code: number | null }): CheckStatus {
  // `errored` is distinct from `failed`: a check the runner could not start
  // measured nothing, and treating it as a failure would put the blame on the
  // change. Both close the gate; only one is about the change.
  if (result.timed_out || result.code === null) return "errored";
  return result.code === 0 ? "passed" : "failed";
}

/** The parsed failure lines, ordered evidence first and totals last, under the cap. */
function evidenceBlock(parse: TestOutput): string {
  if (parse.evidence.length === 0 && parse.summary.length === 0) return "";
  const totals = parse.summary.join("\n");
  const room = Math.max(0, CHECK_EVIDENCE_MAX_CHARS - totals.length);
  const kept: string[] = [];
  let used = 0;
  for (const line of parse.evidence) {
    if (used + line.length + 1 > room) {
      kept.push("…");
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, ...parse.summary].join("\n");
}

/**
 * What the record keeps of a command's output.
 *
 * Both streams, not one: a test task run through a build tool writes its
 * failures to stdout and only its own exit line to stderr, so a record that
 * prefers stderr keeps the exit line and loses the failures.
 */
function composeDetail(stdout: string, stderr: string, parse: TestOutput): string | null {
  const raw = [stdout, stderr]
    .map((stream) => stream.replace(ANSI, "").trim())
    .filter((stream) => stream.length > 0)
    .join("\n");
  const block = evidenceBlock(parse);
  if (block.length === 0) return raw.slice(-CHECK_DETAIL_MAX_CHARS) || null;
  const room = Math.max(0, CHECK_DETAIL_MAX_CHARS - block.length - 2);
  const tail = raw.slice(-room);
  return `${tail}\n\n${block}`.slice(-CHECK_DETAIL_MAX_CHARS);
}

/** One check as it ran, before the re-run decides what the record says. */
interface Observation {
  check: PinnedCheck;
  /** The argv that ran, joined: the check's own command, or the narrowed one. */
  command: string;
  status: CheckStatus;
  summary: string;
  detail: string | null;
  duration_ms: number;
  parse: TestOutput;
  resolved: ResolvedFailure[];
  /** The node the run was for, or `null` for the run over the whole change. */
  node: CheckNode | null;
}

/** What running a plan's steps in order measured. */
interface RunOutcome {
  status: CheckStatus;
  /** The deciding step's summary: the first that did not pass, else the last. */
  summary: string;
  detail: string | null;
  duration_ms: number;
  parse: TestOutput;
  /** The deciding step's own parsed summary line, where its output had one. */
  deciding_summary: string | null;
}

/**
 * Run a check's steps in order, every one of them: the status is the first
 * that did not pass, and the steps after it still run, so the files a record
 * names are the files that ran.
 *
 * One step for a check run as it is declared; one per package for a run
 * narrowed to files. A step that ran inside a package names its files relative
 * to that package, and the record names them relative to the worktree, so the
 * two halves of a check's output can be read against each other.
 */
async function runSteps(args: {
  steps: readonly RerunStep[];
  worktree: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<RunOutcome> {
  const out: string[] = [];
  const err: string[] = [];
  const failing: FailingTest[] = [];
  const evidence: string[] = [];
  const summaries: string[] = [];
  let status: CheckStatus = "passed";
  let duration = 0;
  // The step the record speaks for: the first that did not pass, else the last.
  let deciding: { stdout: string; stderr: string; code: number | null; summary: string | null } | null = null;

  for (const step of args.steps) {
    const result = await run(step.argv, {
      cwd: step.cwd,
      env: args.env,
      timeoutMs: args.timeoutMs,
    });
    duration += result.duration_ms;
    out.push(result.stdout);
    err.push(result.stderr);
    const parsed = parseTestOutput(`${result.stdout}\n${result.stderr}`);
    failing.push(...parsed.failing.map((one) => relocate(one, step.cwd, args.worktree)));
    evidence.push(...parsed.evidence);
    summaries.push(...parsed.summary);
    const stepStatus = statusOf(result);
    const own = {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      summary: parsed.summary[parsed.summary.length - 1] ?? null,
    };
    if (status === "passed" && stepStatus !== "passed") {
      status = stepStatus;
      deciding = own;
    } else if (status === "passed") {
      deciding = own;
    }
  }

  const stdout = out.join("\n");
  const stderr = err.join("\n");
  const parse: TestOutput = { failing, evidence, summary: [...new Set(summaries)] };
  return {
    status,
    summary:
      deciding === null
        ? summarise(stdout, stderr, 0)
        : summarise(deciding.stdout, deciding.stderr, deciding.code),
    detail: composeDetail(stdout, stderr, parse),
    duration_ms: duration,
    parse,
    deciding_summary: deciding?.summary ?? null,
  };
}

/** A failure a step named inside a package, renamed to the worktree it is in. */
function relocate(failure: FailingTest, cwd: string, worktree: string): FailingTest {
  if (cwd === worktree || failure.package_name !== null || isAbsolute(failure.file)) return failure;
  const prefix = relative(worktree, cwd).split(sep).join("/");
  if (prefix.length === 0 || prefix.startsWith("..")) return failure;
  return { ...failure, file: `${prefix}/${failure.file}` };
}

/**
 * Tests known to fail under a loaded machine and not yet fixed (SCP-246).
 *
 * {@link runPinnedChecks} reads this list: a unit check whose failing tests are
 * all named here does not close the gate — the failure is a named debt, not
 * evidence against the change under review. Empty is the goal; every entry
 * names the ticket that empties it.
 */
export interface QuarantinedTest {
  /** The failing test's file, relative to the repository root. */
  test: string;
  /** Why it is quarantined rather than fixed. */
  reason: string;
  /** The ticket that empties this entry. */
  ticket: string;
}

export const QUARANTINED_TESTS: readonly QuarantinedTest[] = [];

export async function runPinnedChecks(args: {
  checks: readonly PinnedCheck[];
  worktree: string;
  env: NodeJS.ProcessEnv;
  secrets: SecretIndex;
  onProgress?: (message: string) => void;
  /**
   * The temporary-directory names the runner's own process was started with.
   * Defaults to the values read when the module loaded.
   */
  hostEnv?: NodeJS.ProcessEnv;
  /**
   * Tests quarantined against SCP-246, overridable for tests. Defaults to the
   * repository's own list.
   */
  quarantine?: readonly QuarantinedTest[];
  /**
   * The approved plan's execution-graph nodes (D-107). Empty for a flat plan,
   * which then runs and records exactly what it did before graphs existed.
   */
  nodes?: readonly PlanNode[];
  /** The sealed change set's files, which a node's narrowed run is drawn from. */
  changed_files?: readonly string[];
}): Promise<CheckResult[]> {
  const progress = args.onProgress ?? (() => undefined);
  const quarantine = args.quarantine ?? QUARANTINED_TESTS;
  const nodes = args.nodes ?? [];
  const changed_files = args.changed_files ?? [];
  const observations: Observation[] = [];

  // The checks run under the host's temporary directory, not the executor's
  // scratch one (SCP-168): a check is the repository's own suite, and it must
  // see what it sees on a developer's machine and on CI. The re-run below uses
  // the same environment, so both runs of a suite answer the same question.
  const env = turboForceEnvironment(hostTemporaryEnvironment(args.env, args.hostEnv));
  const tmpdir = env.TMPDIR ?? null;

  // Every check as it is going to run, decided once: the argv below is the one
  // that is spawned, the one the record carries and the one a re-run repeats,
  // so none of the three can describe a run that did not happen.
  const checks = args.checks.map((check) => ({ ...check, command: withTurboForce(check.command) }));

  // One at a time, in the declared order. The re-run below depends on it: a
  // suite re-run beside the checks that were competing with it for the machine
  // would answer a different question from the one that was asked.
  for (const check of checks) {
    progress(`check ${check.name}: ${check.command.join(" ")}`);
    const outcome = await runSteps({
      steps: [{ argv: [...check.command], cwd: args.worktree }],
      worktree: args.worktree,
      env,
      timeoutMs: check.timeout_ms,
    });
    observations.push({
      check,
      command: check.command.join(" "),
      ...outcome,
      resolved: resolveFailures(outcome.parse.failing, args.worktree),
      node: null,
    });
  }

  const record = (observed: Observation, rerun: RerunOutcome | null): CheckResult =>
    toResult({ observed, rerun, quarantine, secrets: args.secrets, tmpdir });

  const results: CheckResult[] = [];
  for (const observed of observations) {
    const rerun =
      observed.check.kind === "unit" && observed.status === "failed"
        ? await rerunOnce({ observed, worktree: args.worktree, env, progress })
        : null;
    results.push(record(observed, rerun));
  }

  /**
   * The same checks again, once per node of the execution graph (D-107).
   *
   * After the whole-change run and never beside it: the results above are what
   * judges the change, and they are complete before anything narrowed runs. A
   * node's own run is evidence for that node's review and gates nothing, so a
   * node whose check fails neither stops the nodes after it nor changes what
   * the whole change measured.
   */
  for (const node of nodes) {
    for (const check of checks) {
      const plan = NARROWABLE_KINDS.has(check.kind)
        ? planNodeRun({
            command: check.command,
            worktree: args.worktree,
            paths: node.paths,
            changed_files,
          })
        : {
            steps: [{ argv: [...check.command], cwd: args.worktree }],
            scope: "task" as const,
            note: `a ${check.kind} check is not a test run, so a file list does not narrow it`,
            files: [] as string[],
          };
      const command = joinSteps(plan.steps);
      progress(`node ${node.id} check ${check.name} (${plan.scope}): ${command}`);
      const outcome = await runSteps({
        steps: plan.steps,
        worktree: args.worktree,
        env,
        timeoutMs: check.timeout_ms,
      });
      const observed: Observation = {
        check,
        command,
        ...outcome,
        resolved: resolveFailures(outcome.parse.failing, args.worktree),
        node:
          plan.scope === "files"
            ? { node_id: node.id, scope: "files", paths: plan.files, note: null }
            : {
                node_id: node.id,
                scope: "task",
                paths: [],
                note: plan.note ?? "the check ran over the whole change for this node",
              },
      };
      // A failed narrowed run goes again, the same files in the same package:
      // a node result that did not reproduce is as misleading as a whole-change
      // one that did not, and there is nothing narrower left to run. A `task`
      // run does not: it repeats the whole-change command, which the run above
      // has already measured and, where it failed, already re-run, and one
      // more per node would multiply a whole suite by the graph's size for
      // evidence that gates nothing.
      const rerun =
        check.kind === "unit" && outcome.status === "failed" && plan.scope === "files"
          ? await rerunSteps({
              steps: plan.steps,
              scope: "files",
              note: null,
              worktree: args.worktree,
              env,
              timeoutMs: check.timeout_ms,
              progress,
              label: `re-run ${check.name} (node ${node.id})`,
            })
          : null;
      const result = record(observed, rerun);
      if (result.status !== "passed") {
        progress(`node ${node.id}: ${check.name} ${result.status} — ${result.summary}`);
      }
      results.push(result);
    }
  }
  return results;
}

/**
 * The check kinds a node's run can be narrowed to a file list (D-107).
 *
 * The narrow form is `pnpm exec vitest run <files>`, so it is the check's own
 * question only where the check is a vitest run of unit tests — the one kind
 * the failed-check re-run already narrows this way. Every other kind runs once
 * over the whole change for the node instead: `scope` and `policy` are
 * computed over the change as a whole; `typecheck` and `lint` answer a
 * different question over a subset of a project, where an error in a file the
 * subset leaves out simply does not appear; `regression-baseline` runs the
 * change's own tests against the base; `integration`, `secret-scan`,
 * `dependency`, `licence`, `migration` and `other` take no file list at all.
 */
const NARROWABLE_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>(["unit"]);

/** Several steps as one command line, which is what the record shows. */
const joinSteps = (steps: readonly RerunStep[]): string =>
  steps.map((step) => step.argv.join(" ")).join(" ; ");

/** The record of one run, after its re-run has decided what it says. */
function toResult(args: {
  observed: Observation;
  rerun: RerunOutcome | null;
  quarantine: readonly QuarantinedTest[];
  secrets: SecretIndex;
  tmpdir: string | null;
}): CheckResult {
  const { observed, rerun } = args;
  const failing = observed.resolved.map((failure) => failure.label);
  const flaky = rerun !== null && rerun.status === "passed";

  // A failure that reproduces (so it is not `flaky`) is still not new
  // evidence against the change when every test it named is on the
  // quarantine list: it is a debt the named ticket owns, not this one.
  // Unresolvable failures (no file the runner could place on disk) are
  // never quarantined — there is nothing to match a list entry against.
  const quarantineEntries =
    !flaky && observed.status !== "passed" && observed.status !== "skipped" && observed.resolved.length > 0
      ? matchQuarantine(observed.resolved, args.quarantine)
      : null;
  const quarantined = quarantineEntries !== null;
  const redact = (text: string) => args.secrets.redact(text).text;

  return CheckResultSchema.parse({
    check_id: observed.check.check_id,
    name: observed.check.name,
    kind: observed.check.kind,
    // The round is judged on the re-run: a failure that did not reproduce
    // when its own tests ran alone is not evidence against the change.
    // Only an unambiguous pass reopens the gate — a re-run that timed out
    // or could not start says nothing, and leaves the failure standing.
    // A quarantined failure reopens it too, by name rather than by rerun.
    status: flaky || quarantined ? "passed" : observed.status,
    summary: redact(
      flaky
        ? flakySummary(failing.length)
        : quarantined
          ? quarantineSummary(quarantineEntries)
          : observed.summary,
    ),
    command: observed.command,
    // Capped last, from the end: the parsed failure lines and the re-run's
    // own line are at the tail, so the cut takes raw log and not evidence.
    detail:
      observed.detail === null
        ? null
        : redact(withRerunNote(observed.detail, rerun)).slice(-CHECK_DETAIL_MAX_CHARS),
    duration_ms: observed.duration_ms,
    source: "file",
    // Absent means configured, which is what a check read out of a file is.
    ...(observed.check.origin === "proposed" ? { origin: "proposed" } : {}),
    tmpdir: args.tmpdir,
    failing_tests: failing.map(redact),
    reruns: rerun === null ? 0 : 1,
    flaky,
    rerun:
      rerun === null
        ? null
        : {
            command: rerun.command,
            scope: rerun.scope,
            note: rerun.note,
            status: rerun.status,
            summary: redact(rerun.summary),
            failing_tests: rerun.failing_tests.map(redact),
            duration_ms: rerun.duration_ms,
          },
    // Absent on a whole-change result, which is what judges the change.
    ...(observed.node === null ? {} : { node: observed.node }),
  });
}

const flakySummary = (count: number): string =>
  count === 0
    ? "flaky: the check failed, then passed when it was run again alone"
    : `flaky: ${count} test(s) failed, then passed when re-run alone`;

/**
 * The quarantine entry for every one of a check's failing tests, or `null` if
 * any of them is not on the list.
 *
 * Matched on `worktree_path` — the failure's location as resolved to a real
 * file in this worktree — never on the raw label a test runner printed, so an
 * entry names exactly the file a person would open to fix it.
 */
function matchQuarantine(
  failures: readonly ResolvedFailure[],
  quarantine: readonly QuarantinedTest[],
): QuarantinedTest[] | null {
  const matched: QuarantinedTest[] = [];
  for (const failure of failures) {
    const entry =
      failure.worktree_path === null
        ? undefined
        : quarantine.find((candidate) => candidate.test === failure.worktree_path);
    if (entry === undefined) return null;
    matched.push(entry);
  }
  // One row per quarantined file, not one per failing test case inside it.
  return [...new Map(matched.map((entry) => [entry.test, entry])).values()];
}

const quarantineSummary = (entries: readonly QuarantinedTest[]): string =>
  `quarantined: ${entries
    .map((entry) => `${entry.test} (${entry.ticket}): ${entry.reason}`)
    .join("; ")}`;

/** The record's own note that a second run happened, kept with the first run's log. */
function withRerunNote(detail: string, rerun: RerunOutcome | null): string {
  if (rerun === null) return detail;
  const verdict = rerun.status === "passed" ? "passed" : `${rerun.status}`;
  return `${detail}\n\nre-run (${rerun.scope}): ${rerun.command} — ${verdict}${
    rerun.note === null ? "" : ` (${rerun.note})`
  }`;
}

interface RerunOutcome {
  command: string;
  scope: "files" | "task";
  note: string | null;
  status: CheckStatus;
  summary: string;
  failing_tests: string[];
  duration_ms: number;
}

/**
 * Run a failed unit check's tests once more, on their own.
 *
 * The file paths in the argv are the ones the check's own output named, after
 * `resolveFailures` has established each is a relative path inside a package
 * of this worktree and present on disk. A name that does not survive that is
 * not passed to a process: the whole check runs again instead.
 */
async function rerunOnce(args: {
  observed: Observation;
  worktree: string;
  env: NodeJS.ProcessEnv;
  progress: (message: string) => void;
}): Promise<RerunOutcome> {
  const plan = planRerun({
    command: args.observed.check.command,
    worktree: args.worktree,
    resolved: args.observed.resolved,
  });
  return rerunSteps({
    steps: plan.steps,
    scope: plan.scope,
    note: plan.note,
    worktree: args.worktree,
    env: args.env,
    timeoutMs: args.observed.check.timeout_ms,
    progress: args.progress,
    label: `re-run ${args.observed.check.name} (${plan.scope})`,
  });
}

/** The second run itself, whatever decided which steps it is. */
async function rerunSteps(args: {
  steps: readonly RerunStep[];
  scope: "files" | "task";
  note: string | null;
  worktree: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  progress: (message: string) => void;
  label: string;
}): Promise<RerunOutcome> {
  const command = joinSteps(args.steps);
  args.progress(`${args.label}: ${command}`);
  const outcome = await runSteps({
    steps: args.steps,
    worktree: args.worktree,
    env: args.env,
    timeoutMs: args.timeoutMs,
  });
  return {
    command,
    scope: args.scope,
    note: args.note,
    status: outcome.status,
    summary: outcome.deciding_summary ?? outcome.summary,
    failing_tests: resolveFailures(outcome.parse.failing, args.worktree).map(
      (failure) => failure.label,
    ),
    duration_ms: outcome.duration_ms,
  };
}
