import { UsageError } from "../../usage-error.js";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../../command-line/grammar.js";
import { baselinePath, readBaselineFile, writeBaselineFile } from "./internal/file.js";
import {
  BASELINE_COMPARISON_MINIMUM,
  BaselineStateError,
  abandonBaseline,
  baselineElapsedMs,
  openBaseline,
  pauseBaseline,
  resumeBaseline,
  startBaseline,
  stopBaseline,
  summarizeBaseline,
  type BaselineFile,
} from "./internal/stopwatch.js";
import {
  E1_COMMANDS,
  E1_GRAMMARS,
  e1,
  e1GrammarFor,
  isE1Command,
  readE1,
  renderE1,
  type E1Input,
  type E1Report,
} from "./internal/e1/command.js";
import { formatDuration } from "../run/index.js";
import type { CommandContext, Rendered } from "../../command.js";
import type { ReportCommand } from "../../command-line/terminal.js";
import { storeFor, type StoreTarget } from "../../store/index.js";
import { listTickets } from "../../store/tickets.js";

/**
 * `perbo baseline` — the partner's direct-agent wall clock (D-038, SCP-080).
 *
 * A stopwatch over the workflow Perbo is to be compared against, kept in the
 * repository's own `.perbo/baseline.json`. It has to be run before the first
 * ticket goes through the loop, and the file records whether it was: `start`
 * asks whether work is already admitted here and, if it is, marks the capture
 * as late rather than refusing — a late number is still a number, it just is
 * not the one D-038 asked for.
 */

export interface StopwatchInput {
  command: "start" | "pause" | "resume" | "stop" | "abandon" | "list";
  target: StoreTarget;
  title: string | null;
  ref: string | null;
  pullRequest: string | null;
  note: string | null;
  reason: string | null;
}

/** Either half of the measurement: the stopwatch's verbs, or the harness's. */
export type BaselineInput =
  | { readonly kind: "stopwatch"; readonly input: StopwatchInput }
  | { readonly kind: "harness"; readonly input: E1Input };

/** What one stopwatch verb did: the file it read, or the entry it moved. */
export type StopwatchReport =
  | { readonly kind: "listed"; readonly file: BaselineFile; readonly path: string; readonly now: Date }
  | {
      readonly kind: "moved";
      readonly verb: Exclude<StopwatchInput["command"], "list">;
      readonly entry: BaselineFile["entries"][number];
      readonly now: Date;
      /** `start` only: a ticket was already admitted, so this capture is late. */
      readonly late: string | null;
    };

export type BaselineReport =
  | { readonly kind: "stopwatch"; readonly report: StopwatchReport }
  | { readonly kind: "harness"; readonly report: E1Report };

const COMMANDS = new Set(["start", "pause", "resume", "stop", "abandon", "list"]);
const harness = () =>
  `The E1 harness — a partner's ten, sealed, and the ratio against them — is baseline ${E1_COMMANDS.join(" | ")}.`;

/**
 * One table for every verb, so a flag that belongs to another one parses and
 * is then refused by name: `--pr does not apply to baseline start` says what
 * `unknown flag` cannot.
 */
const BASELINE_FLAGS = {
  "--ref": valueFlag(),
  "--pr": valueFlag(),
  "--note": valueFlag(),
  "--reason": valueFlag(),
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

/** What each verb takes after itself: `start` its title, the rest nothing. */
const baselineGrammar = (command: StopwatchInput["command"]): Grammar<typeof BASELINE_FLAGS> => ({
  command: `baseline ${command}`,
  flags: BASELINE_FLAGS,
  positionals:
    command === "start"
      ? {
          min: 1,
          max: 1,
          refusal: 'baseline start takes one title, e.g. perbo baseline start "Paginate search"',
        }
      : { min: 0, max: 0, refusal: `baseline ${command} takes no positional argument` },
  afterDoubleDash: "positionals",
});

function readStopwatch(argv: readonly string[]): { input: StopwatchInput; output: { json: boolean } } {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) {
    throw new UsageError(
      `baseline needs one of: start "<title>" [--ref owner/repo#N], pause, resume, ` +
        `stop [--pr <url>] [--note "..."], abandon [--reason "..."], list [--json]. ` +
        harness(),
    );
  }
  const verb = command as StopwatchInput["command"];
  const line = parseArgv(baselineGrammar(verb), rest);
  const args: StopwatchInput = {
    command: verb,
    target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
    title: null,
    ref: line.flags["--ref"] ?? null,
    pullRequest: line.flags["--pr"] ?? null,
    note: line.flags["--note"] ?? null,
    reason: line.flags["--reason"] ?? null,
  };
  if (verb === "start") {
    const title = line.positionals[0]!;
    if (title.trim() === "") {
      throw new UsageError('baseline start takes one title, e.g. perbo baseline start "Paginate search"');
    }
    args.title = title;
  }
  const allowed: Record<StopwatchInput["command"], Array<keyof StopwatchInput>> = {
    start: ["ref"],
    pause: [],
    resume: [],
    stop: ["pullRequest", "note"],
    abandon: ["reason"],
    list: [],
  };
  for (const [field, flag] of [
    ["ref", "--ref"],
    ["pullRequest", "--pr"],
    ["note", "--note"],
    ["reason", "--reason"],
  ] as const) {
    if (args[field] !== null && !allowed[args.command].includes(field)) {
      throw new UsageError(`${flag} does not apply to baseline ${args.command}`);
    }
  }
  return { input: args, output: { json: line.flags["--json"] === true } };
}

/** Every verb's grammar, for the check that the help names each flag exactly once. */
const STOPWATCH_VERBS = ["start", "pause", "resume", "stop", "abandon", "list"] as const;
const BASELINE_GRAMMARS = STOPWATCH_VERBS.map(baselineGrammar);

/** The verb a line names, or `list`'s grammar for one that names none: `read` refuses it. */
const stopwatchVerb = (token: string | undefined): StopwatchInput["command"] =>
  (STOPWATCH_VERBS as readonly string[]).includes(token ?? "")
    ? (token as StopwatchInput["command"])
    : "list";

export function renderBaselineList(file: BaselineFile, path: string, now: Date): string {
  const summary = summarizeBaseline(file);
  const lines: string[] = [];
  lines.push(`BASELINE  ${path}`);
  lines.push(`  captured before first use   ${file.captured_before_first_use ? "yes" : "no — a ticket was already admitted"}`);
  lines.push(
    `  entries   ${summary.entries} · ${summary.completed} completed · ${summary.abandoned} abandoned` +
      (summary.open ? " · 1 open" : ""),
  );
  lines.push(
    `  median    ${summary.median_elapsed_ms === null ? "—" : formatDuration(summary.median_elapsed_ms)}`,
  );
  lines.push(`  p90       ${summary.p90_elapsed_ms === null ? "—" : formatDuration(summary.p90_elapsed_ms)}`);
  if (file.entries.length > 0) lines.push("");
  for (const entry of file.entries) {
    const state =
      entry.outcome ?? (entry.paused_at !== null ? "paused" : "running");
    const elapsed = formatDuration(baselineElapsedMs(entry, now));
    lines.push(
      `  ${entry.id}  ${state.padEnd(9)} ${elapsed.padStart(8)}  ${entry.title}` +
        (entry.ref ? `  ${entry.ref}` : "") +
        (entry.pull_request_url ? `  ${entry.pull_request_url}` : ""),
    );
  }
  if (summary.short_of_comparison > 0) {
    lines.push(
      "",
      `  warning   the comparison wants ${BASELINE_COMPARISON_MINIMUM} completed entries; ` +
        `${summary.completed} so far, ${summary.short_of_comparison} to go`,
    );
  }
  return lines.join("\n");
}

function stopwatch(input: StopwatchInput, context: CommandContext): StopwatchReport {
  const args = input;
  const now = context.now;
  const store = storeFor(context.cwd, input.target);
  const path = baselinePath(store);
  const before = readBaselineFile(path);

  if (args.command === "list") {
    return { kind: "listed", file: before, path, now };
  }

  let after: BaselineFile;
  try {
    switch (args.command) {
      case "start":
        after = startBaseline(before, {
          title: args.title!,
          ref: args.ref,
          now,
          ticketsExist: listTickets(store).length > 0,
        });
        break;
      case "pause":
        after = pauseBaseline(before, now);
        break;
      case "resume":
        after = resumeBaseline(before, now);
        break;
      case "stop":
        after = stopBaseline(before, { now, pull_request_url: args.pullRequest, note: args.note });
        break;
      case "abandon":
        after = abandonBaseline(before, { now, reason: args.reason });
        break;
    }
  } catch (error) {
    if (error instanceof BaselineStateError) throw new UsageError(error.message);
    throw error;
  }
  writeBaselineFile(path, after);

  const entry =
    args.command === "start" || args.command === "pause" || args.command === "resume"
      ? openBaseline(after)!
      : after.entries.find((candidate) => openBaseline(before)?.id === candidate.id)!;
  return {
    kind: "moved",
    verb: args.command,
    entry,
    now,
    late:
      args.command === "start" && before.captured_before_first_use && !after.captured_before_first_use
        ? store
        : null,
  };
}

/** What the stopwatch did, in the one line a person reads it back as. */
function renderStopwatch(report: StopwatchReport, json: boolean): Rendered {
  if (report.kind === "listed") {
    return {
      stdout: json
        ? `${JSON.stringify(
            { ...report.file, path: report.path, summary: summarizeBaseline(report.file) },
            null,
            2,
          )}\n`
        : `${renderBaselineList(report.file, report.path, report.now)}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  const { entry, now } = report;
  const stderr =
    report.late === null
      ? ""
      : `warning: a ticket is already admitted in ${report.late}, so this baseline is recorded as ` +
        "captured after first use — it is not the number to compare against\n";
  switch (report.verb) {
    case "start":
      return { stdout: `started ${entry.id} "${entry.title}" at ${entry.started_at}\n`, stderr, exitCode: 0 };
    case "pause":
      return {
        stdout: `paused ${entry.id} at ${entry.paused_at} (${formatDuration(baselineElapsedMs(entry, now))} so far)\n`,
        stderr,
        exitCode: 0,
      };
    case "resume":
      return {
        stdout: `resumed ${entry.id} (${formatDuration(entry.paused_ms)} paused in total)\n`,
        stderr,
        exitCode: 0,
      };
    case "stop":
      return {
        stdout:
          `completed ${entry.id} "${entry.title}": ${formatDuration(entry.elapsed_ms ?? 0)} ` +
          `(${formatDuration(entry.paused_ms)} paused)` +
          (entry.pull_request_url ? ` → ${entry.pull_request_url}` : "") +
          "\n",
        stderr,
        exitCode: 0,
      };
    case "abandon":
      return {
        stdout:
          `abandoned ${entry.id} "${entry.title}" after ${formatDuration(entry.elapsed_ms ?? 0)}` +
          (entry.note ? `: ${entry.note}` : "") +
          "\n",
        stderr,
        exitCode: 0,
      };
  }
}

/**
 * The stopwatch and the harness are one command because they are one
 * measurement: `internal/e1/` is where a reading becomes a partner's sealed
 * ten and the ratio the product is held to (D-038, SCP-080).
 */
export const baselineCommandLine: ReportCommand<
  BaselineInput,
  { json: boolean },
  BaselineReport
> = {
  kind: "report",
  name: "baseline",
  grammars: [...BASELINE_GRAMMARS, ...E1_GRAMMARS],
  // `list` and `result` print their record to a pipe without being asked; the
  // verbs that write one line print that line either way.
  jsonWhenPiped: true,
  grammarFor: (argv) =>
    isE1Command(argv[0]) ? e1GrammarFor(argv[0]) : baselineGrammar(stopwatchVerb(argv[0])),
  read(argv) {
    if (isE1Command(argv[0])) {
      const { input, output } = readE1(argv);
      return { input: { kind: "harness", input }, output };
    }
    const { input, output } = readStopwatch(argv);
    return { input: { kind: "stopwatch", input }, output };
  },
  run: (input, context) =>
    input.kind === "harness"
      ? { kind: "harness", report: e1(input.input, context) }
      : { kind: "stopwatch", report: stopwatch(input.input, context) },
  render: (report, _output, target) =>
    report.kind === "harness"
      ? renderE1(report.report, target.json)
      : renderStopwatch(report.report, target.json),
};

/**
 * What `perbo escapes` reads of the same file: where it is, and the schema it
 * parses a store's baseline with.
 */
export { baselinePath } from "./internal/file.js";
export { BaselineFileSchema, type BaselineFile } from "./internal/stopwatch.js";
