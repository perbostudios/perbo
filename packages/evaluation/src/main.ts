#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { formatUsd, type CheckResult } from "@perbo/contracts";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  matchesFilter,
  runCorpus,
  selectFixtures,
  type HarnessResult,
} from "./harness.js";
import { assertBundleSource, assertBundleToolchain } from "./bundle.js";
import { renderReport } from "./report.js";
import { measureRunnable, renderRunnable, type RunnableResult } from "./runnable.js";
import { prepareFixture, renderPrepared, type PreparedFixture } from "./prepare.js";
import { measureBaseline, renderBaselines, type BaselineResult } from "./baseline.js";
import { defaultCacheDir, defaultCorpusDir, loadCorpus, type LoadedFixture } from "./corpus.js";
import { ruleAuthorityFrom, summariseCorpus } from "./summarise.js";
import { withRecallDefinitions, withRecallLabels } from "./score.js";
import { parseUsd } from "./spend.js";
import { serialiseRunsFile } from "./runs-file.js";
import {
  buildCorpusRunManifest,
  captureRunSource,
  type RunSourceSnapshot,
} from "./run-manifest.js";

/**
 * `perbo-corpus` — run the seeded-defect corpus and report the numbers D-010
 * states thresholds against.
 *
 * It spawns the real `perbo` binary, so a corpus run and a real run are the
 * same program. Anthropic uses ANTHROPIC_API_KEY; CLI transports use their own
 * local credentials. It makes fixtures × repeats reviews — the default is a
 * dry listing, and `--run` is the flag that spends provider usage.
 */

const USAGE = `perbo-corpus — run the seeded-defect corpus

  perbo-corpus --run --repeats 3 --out .local/corpus
  perbo-corpus runnable [--write]
  perbo-corpus prepare

  --run              actually invoke the reviewer. Without it, list the corpus and stop
  --dry-run          say that out loud: list the selection and spend nothing. Refused with --run
  --repeats <n>      runs per fixture (default 3; D-050 requires at least three)
  --concurrency <n>  fixtures in flight (default 4)
  --review-timeout <s>  kill a spawned reviewer still running after this many seconds (default
                     ${DEFAULT_REVIEW_TIMEOUT_MS / 1000} = ${DEFAULT_REVIEW_TIMEOUT_MS / 60_000} min, sized from docs/04's review-latency budget: "four
                     minutes at p95 is tolerable and fifteen is not"). A killed review's result is
                     recorded partial: timeout, naming the deadline, and this run's deadline is
                     stated in run-manifest.json
  --filter <substr>  only fixtures whose id contains this; comma separates alternatives
  --suite <name>     only the fixtures named in corpus/<name>-suite.json ('regression': the thirty
                     that run on a reviewer, routing or model change); combines with --filter
  --model <id>       reviewer model override
  --provider <name>  'anthropic' (default), 'claude-cli' or 'codex-cli'
  --out <dir>        where results, artifacts and the report are written. --run also copies the
                     reviewer into <dir>/bin before the first fixture and spawns only that copy
  --corpus <dir>     override the fixture directory
  --max-spend <usd>  stop launching reviews before the transport-reported total would cross this
                     ceiling ('2.50' or '$2.50'). The run is then recorded as partial, and no
                     threshold on it is reported as met

Subcommands
  prepare            clone the repositories that pinned fixtures name, at the commits they
                     pin, into .local/corpus-cache. No upstream code is ever checked in.
  baseline           run a fixture's own tests without its change: a pinned fixture's at its
                     base commit, an authored fixture's against its before/ tree. --write
                     records pinned results into checks.json; authored results are printed
                     only (SCP-110).
  runnable           can each fixture's own tree install and run its suite? Measured, and
                     with --write the answer is recorded back into fixture.json
`;

type ReviewerProvider = "anthropic" | "claude-cli" | "codex-cli";

interface Args {
  command: "run" | "runnable" | "prepare" | "baseline";
  write: boolean;
  run: boolean;
  /** The listing, asked for rather than fallen into. Refused beside `run`. */
  dryRun: boolean;
  repeats: number;
  concurrency: number;
  /** How long a spawned review may run before the harness kills it, in milliseconds. */
  reviewTimeoutMs: number;
  filter: string | null;
  /** A named fixture list under corpus/, applied as an exact-id filter (docs/evaluation/regression-suite.md). */
  suite: string | null;
  model: string | null;
  provider: ReviewerProvider | null;
  out: string;
  corpus: string | null;
  /** The enforced spend ceiling in micro-dollars, or null for an unbounded run. */
  maxSpendMicros: number | null;
}

function parse(argv: string[]): Args {
  const args: Args = {
    command: "run",
    write: false,
    run: false,
    dryRun: false,
    repeats: 3,
    concurrency: 4,
    reviewTimeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
    filter: null,
    suite: null,
    model: null,
    provider: null,
    out: ".local/corpus",
    corpus: null,
    maxSpendMicros: null,
  };
  const rest = [...argv];
  if (
    ["runnable", "prepare", "baseline"].includes(
      rest[0] ?? "",
    )
  ) {
    args.command = rest.shift() as Args["command"];
  }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${token} requires a value`);
      return next;
    };
    switch (token) {
      case "--run":
        args.run = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--write":
        args.write = true;
        break;
      case "--repeats":
        args.repeats = Number(value());
        break;
      case "--concurrency":
        args.concurrency = Number(value());
        break;
      case "--review-timeout": {
        const raw = value();
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(
            `--review-timeout requires a positive number of seconds, not '${raw}'`,
          );
        }
        args.reviewTimeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--filter":
        args.filter = value();
        break;
      case "--suite":
        args.suite = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--provider":
        {
          const chosen = value();
          if (
            chosen !== "anthropic" &&
            chosen !== "claude-cli" &&
            chosen !== "codex-cli"
          ) {
            throw new Error(
              "--provider must be 'anthropic', 'claude-cli' or 'codex-cli'",
            );
          }
          args.provider = chosen;
        }
        break;
      case "--out":
        args.out = value();
        break;
      case "--corpus":
        args.corpus = value();
        break;
      case "--max-spend": {
        const raw = value();
        const micros = parseUsd(raw);
        if (micros === null || micros === 0) {
          throw new Error(
            `--max-spend requires a positive dollar amount ('2.50' or '$2.50'), not '${raw}'`,
          );
        }
        args.maxSpendMicros = micros;
        break;
      }
      case "--help":
      case "-h":
        process.stderr.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag '${token}'`);
    }
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) {
    throw new Error("--repeats requires a positive integer");
  }
  if (args.dryRun && args.run) {
    throw new Error(
      "--dry-run and --run ask for opposite things: --dry-run lists the selection and spends " +
        "nothing, --run invokes the reviewer",
    );
  }
  return args;
}

/** The reviewer entry point the harness spawns: the real `perbo` binary. */
function cliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@perbo/cli")), "main.js");
}

const SuiteSchema = z.object({ name: z.string(), fixtures: z.array(z.string()).min(1) });

/**
 * `--suite <name>` restricts every subcommand to the fixtures named in
 * `corpus/<name>-suite.json`. It is applied as an exact-id filter on top of
 * `--filter`, so the dry listing, the run and every other command select
 * through the same `matchesFilter` and cannot disagree about the population.
 * A fixture id is a directory name and no id is a substring of another, which
 * is what makes the id list an exact filter (`test/suite.test.ts` pins that).
 *
 * An id the corpus does not contain is refused rather than dropped: a suite
 * that quietly shrank would read as a run that passed.
 */
function suiteFilter(
  name: string,
  corpus: readonly LoadedFixture[],
  corpusDir: string | null,
  filter: string | null,
): string {
  const path = resolve(corpusDir ?? defaultCorpusDir(), "..", `${name}-suite.json`);
  if (!existsSync(path)) throw new Error(`unknown suite '${name}': no ${path}`);
  const suite = SuiteSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const known = new Set(corpus.map((entry) => entry.fixture.id));
  const unknown = suite.fixtures.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `suite '${name}' names ${unknown.length} fixture(s) that are not in the corpus: ${unknown.join(", ")}`,
    );
  }
  // An empty intersection becomes a blank filter, which matches nothing and
  // says so, rather than falling back to the whole corpus.
  return suite.fixtures.filter((id) => matchesFilter(id, filter)).join(",");
}

/**
 * What a caller inside this process may substitute.
 *
 * One entry, and it exists so the harness can be driven end to end — argument
 * parsing, the pool, the files it writes — against a
 * stand-in reviewer that costs nothing. It is a function parameter and
 * deliberately not a flag or an environment variable: a corpus run started from
 * a shell spawns the real reviewer and there is no ambient way to make it spawn
 * something else, so a run cannot report itself as normal while a substituted
 * program produced its artifacts. Whatever is spawned is hashed into the run
 * manifest as `cli_entry_sha256` either way, so a stand-in is visible in the
 * record it leaves rather than only in the code that started it.
 */
export interface CorpusOverrides {
  /** The reviewer entry point to spawn, instead of the installed `perbo`. */
  cliPath?: string;
}

/**
 * The whole command, returning the exit code rather than setting it.
 *
 * Exported so the CLI can be driven in process, and invoked below only when
 * this file is the program.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: CorpusOverrides = {},
): Promise<number> {
  const args = parse(argv);
  const corpus = loadCorpus(args.corpus ?? undefined);
  if (args.suite !== null) {
    args.filter = suiteFilter(args.suite, corpus, args.corpus, args.filter);
  }
  const out = resolve(process.cwd(), args.out);
  if (args.command === "prepare") {
    const pinned = corpus.filter(
      (entry) =>
        entry.fixture.pinned_repository !== null &&
        matchesFilter(entry.fixture.id, args.filter),
    );
    if (pinned.length === 0) {
      process.stderr.write("no fixture pins a repository\n");
      return 0;
    }
    const prepared: PreparedFixture[] = [];
    for (const entry of pinned) {
      process.stderr.write(`  ${entry.fixture.id}\n`);
      prepared.push(
        await prepareFixture({
          fixture: entry,
          cacheRoot: resolve(process.cwd(), ".local", "corpus-cache"),
          onProgress: (message) => process.stderr.write(`    ${message}\n`),
        }),
      );
    }
    process.stdout.write(`${renderPrepared(prepared)}\n`);
    return 0;
  }

  if (args.command === "baseline") {
    const selected = corpus.filter((entry) => matchesFilter(entry.fixture.id, args.filter));
    const cacheRoot = args.corpus === null ? defaultCacheDir() : resolve(args.corpus, "..", "cache");
    const results: BaselineResult[] = [];
    for (const entry of selected) {
      process.stderr.write(`  ${entry.fixture.id}\n`);
      results.push(
        await measureBaseline({
          fixture: entry,
          cacheRoot,
          onProgress: (message) => process.stderr.write(`    ${message}\n`),
        }),
      );
    }
    if (args.write) {
      for (const result of results) {
        if (!result.check) continue;
        const entry = selected.find((item) => item.fixture.id === result.fixture_id);
        if (!entry) continue;
        // Authored fixtures are measured but never written: their checks.json
        // is reviewer-visible prop data on scored fixtures, so adding a check
        // there is a pre-registered correction, not a flag.
        if (!entry.pinned) continue;
        const path = join(entry.dir, "checks.json");
        const existing = JSON.parse(readFileSync(path, "utf8")) as CheckResult[];
        const without = existing.filter((check) => check.kind !== "regression-baseline");
        writeFileSync(path, `${JSON.stringify([...without, result.check], null, 2)}\n`);
      }
    }
    process.stdout.write(`${renderBaselines(results)}\n`);
    return 0;
  }

  if (args.command === "runnable") {
    const selected = corpus.filter(
      (entry) => matchesFilter(entry.fixture.id, args.filter),
    );
    const results: RunnableResult[] = [];
    for (const entry of selected) {
      // A pinned fixture is measured in its prepared clone with the commands it
      // declares, not with the corpus's shared runtime files, which mean
      // nothing to a repository that is not a pnpm package.
      process.stderr.write(`  ${entry.fixture.id}\n`);
      results.push(await measureRunnable(entry));
    }
    if (args.write) {
      for (const result of results) {
        const entry = selected.find((item) => item.fixture.id === result.fixture_id);
        if (!entry) continue;
        const path = join(entry.dir, "fixture.json");
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        raw.runtime = result.runtime;
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      }
      process.stderr.write(`  recorded into ${results.length} fixture.json file(s)\n`);
    }
    process.stdout.write(`${renderRunnable(results)}\n`);
    return results.every((result) => result.runtime.status !== "not_installable") ? 0 : 2;
  }

  if (!args.run) {
    // The listing sizes the run through the same selection `runCorpus` uses —
    // filter AND the pinned-but-unprepared exclusion — because it is how a
    // filter is checked before --run spends against it. It previously listed
    // the whole corpus whatever --filter said, and then counted fixtures the
    // run would exclude, so the "that makes N model calls" number was wrong in
    // both directions exactly when someone was using it to size a run.
    const { selected, excluded_unprepared } = selectFixtures(corpus, args.filter);
    process.stderr.write(
      `${selected.length} fixtures${args.filter === null ? "" : ` matching --filter '${args.filter}'`}:\n` +
        selected
          .map(
            (entry) =>
              `  ${entry.fixture.id.padEnd(48)} ${entry.fixture.class.padEnd(22)} ` +
              `${entry.fixture.plan_level}  ${entry.fixture.expected_detection.mode}`,
          )
          .join("\n") +
        (excluded_unprepared.length > 0
          ? `\n\n${excluded_unprepared.length} fixture(s) excluded — they pin a repository that ` +
            `is not prepared (run \`perbo-corpus prepare\`): ${excluded_unprepared.join(", ")}`
          : "") +
        `\n\nPass --run to invoke the reviewer. That makes ${selected.length * args.repeats} model ` +
        "calls and costs money.\n",
    );
    return 0;
  }

  if ((args.provider ?? "anthropic") === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "error: ANTHROPIC_API_KEY is not set. The corpus runs against the model provider and " +
        "cannot produce a number without one.\n",
    );
    return 1;
  }

  mkdirSync(out, { recursive: true });

  const runnerCliPath = overrides.cliPath ?? cliPath();
  let runSource: RunSourceSnapshot;
  let result: HarnessResult;
  try {
    // Both asked before anything is recorded about the run, so a missing
    // reviewer — or a machine with nothing to bundle it with — is one error
    // naming what is missing rather than a snapshot of nothing.
    assertBundleSource(runnerCliPath);
    assertBundleToolchain();
    runSource = captureRunSource({
      cliPath: runnerCliPath,
      providerBinaryPath:
        args.provider === "codex-cli"
          ? (process.env.PERBO_CODEX_BINARY ?? "codex")
          : args.provider === "claude-cli"
            ? "claude"
            : undefined,
      cwd: process.cwd(),
    });
    result = await runCorpus({
      cliPath: runnerCliPath,
      // The run's own copy of the reviewer lands in `<out>/bin/`, is taken
      // before the first fixture, and is what every review is spawned against.
      outDir: out,
      repeats: args.repeats,
      concurrency: args.concurrency,
      reviewTimeoutMs: args.reviewTimeoutMs,
      corpusDir: args.corpus ?? undefined,
      filter: args.filter ?? undefined,
      model: args.model ?? undefined,
      provider: args.provider ?? undefined,
      artifactsDir: join(out, "artifacts"),
      maxSpendMicros: args.maxSpendMicros ?? undefined,
      onProgress: (message) => process.stderr.write(`  ${message}\n`),
    });
  } catch (error) {
    // A run that could not start — most often because it could not take its
    // own copy of the reviewer — has spawned nothing, and says so on stderr
    // rather than going on with the tree's copy: the swap that cost 206 of 270
    // runs is exactly what that fallback would restore.
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (args.maxSpendMicros !== null) {
    process.stderr.write(
      `\nspend ceiling ${formatUsd(args.maxSpendMicros, 2)}: ` +
        `${result.partial ? `reached — ${result.partial.reason}` : "not reached"}\n`,
    );
  }

  // The runs go to disk before anything is computed from them. A corpus run
  // costs an hour and real money, and every number below is derived — so a
  // defect in the derivation must never be able to destroy the measurement it
  // was derived from.
  // A ceiling-stopped run writes the partial marker into runs.json itself,
  // beside the records it did produce. Anything that reads the file reads the
  // reason it is short in the same breath as the rows.
  const serialisedRuns = serialiseRunsFile(result);
  writeFileSync(join(out, "runs.json"), serialisedRuns);
  const runManifest = buildCorpusRunManifest({
    result,
    requestedRepeats: args.repeats,
    serialisedRuns,
    source: runSource,
    reviewTimeoutMs: args.reviewTimeoutMs,
  });
  writeFileSync(join(out, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);

  // SCP-225: every recall row carries which of the two readings it is, and
  // each gated one reports the other reading beside it — `summary.json` and
  // `regression-delta.mjs` both join rows on `name`, so the tag lives in a
  // new `definition` field rather than in the name itself (score.ts).
  const summary = withRecallDefinitions(summariseCorpus(result, args.repeats));
  const authority = ruleAuthorityFrom(result);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, "rule-authority.json"), `${JSON.stringify(authority, null, 2)}\n`);

  const reportModel =
    args.model ??
    (args.provider === "codex-cli" ? "gpt-5.6-terra" : "claude-opus-5");
  // The printed table shows the tag beside the name (`withRecallLabels`);
  // `summary` above keeps the bare name every other consumer joins rows on.
  const report = renderReport(withRecallLabels(summary), { model: reportModel, bundle: result.bundle });
  writeFileSync(join(out, "report.md"), `${report}\n`);

  process.stdout.write(`${report}\n`);
  process.stderr.write(`\nwritten to ${out}\n`);

  // A run the ceiling stopped did not measure its population, and exits saying
  // so: a caller that chains on `&&` must not treat a truncated corpus as a
  // completed one.
  return result.partial ? 2 : 0;
}

/**
 * Whether this module is the program, or something that imported it.
 *
 * `import.meta.main` is the runtime's own answer and is used where it exists.
 * Where it does not, the two paths are compared *after* `realpathSync`: Node
 * resolves the module URL through symlinks but leaves `process.argv[1]` as
 * written, so a package manager's `bin` symlink (this package declares
 * `perbo-corpus`) makes the two spellings differ for the same file — and the
 * command would exit 0 having silently done nothing.
 */
function sameFile(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
}

const invokedDirectly =
  (import.meta as { main?: boolean }).main ??
  sameFile(process.argv[1], fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
