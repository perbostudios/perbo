import { resolve } from "node:path";
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
import { E1_COMMANDS, isE1Command, runE1Command } from "./internal/e1/command.js";
import { formatDuration } from "../run/index.js";
import { storeDir } from "../../store/index.js";
import type { Streams } from "../../streams.js";
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

export interface BaselineArgs {
  command: "start" | "pause" | "resume" | "stop" | "abandon" | "list";
  title: string | null;
  ref: string | null;
  pullRequest: string | null;
  note: string | null;
  reason: string | null;
  json: boolean;
  repo: string;
  store: string | null;
}

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
const baselineGrammar = (command: BaselineArgs["command"]): Grammar<typeof BASELINE_FLAGS> => ({
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

export function parseBaselineArgs(argv: readonly string[]): BaselineArgs {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) {
    throw new UsageError(
      `baseline needs one of: start "<title>" [--ref owner/repo#N], pause, resume, ` +
        `stop [--pr <url>] [--note "..."], abandon [--reason "..."], list [--json]. ` +
        harness(),
    );
  }
  const verb = command as BaselineArgs["command"];
  const line = parseArgv(baselineGrammar(verb), rest);
  const args: BaselineArgs = {
    command: verb,
    title: null,
    ref: line.flags["--ref"] ?? null,
    pullRequest: line.flags["--pr"] ?? null,
    note: line.flags["--note"] ?? null,
    reason: line.flags["--reason"] ?? null,
    json: line.flags["--json"] === true,
    repo: line.flags["--repo"] ?? ".",
    store: line.flags["--store"] ?? null,
  };
  if (verb === "start") {
    const title = line.positionals[0]!;
    if (title.trim() === "") {
      throw new UsageError('baseline start takes one title, e.g. perbo baseline start "Paginate search"');
    }
    args.title = title;
  }
  const allowed: Record<BaselineArgs["command"], Array<keyof BaselineArgs>> = {
    start: ["ref"],
    pause: [],
    resume: [],
    stop: ["pullRequest", "note"],
    abandon: ["reason"],
    list: ["json"],
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
  return args;
}

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

export interface BaselineOptions {
  argv: string[];
  streams: Streams;
  cwd: string;
  /** Injected by tests; the command reads the clock once per invocation. */
  now?: () => Date;
}

export async function runBaselineCommand(input: BaselineOptions): Promise<number> {
  // The stopwatch and the harness are one command because they are one
  // measurement: `internal/e1/` is where a reading becomes a partner's sealed
  // ten and the ratio the product is held to (D-038, SCP-080).
  if (isE1Command(input.argv[0])) {
    const { argv, streams, cwd } = input;
    return runE1Command(input.now ? { argv, streams, cwd, now: input.now } : { argv, streams, cwd });
  }
  const args = parseBaselineArgs(input.argv);
  const now = (input.now ?? (() => new Date()))();
  const store = storeDir(resolve(input.cwd, args.repo), args.store);
  const path = baselinePath(store);
  const before = readBaselineFile(path);

  if (args.command === "list") {
    if (args.json || !input.streams.isTTY) {
      input.streams.stdout(
        `${JSON.stringify({ ...before, path, summary: summarizeBaseline(before) }, null, 2)}\n`,
      );
    } else {
      input.streams.stdout(`${renderBaselineList(before, path, now)}\n`);
    }
    return 0;
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
  switch (args.command) {
    case "start":
      input.streams.stdout(`started ${entry.id} "${entry.title}" at ${entry.started_at}\n`);
      if (before.captured_before_first_use && !after.captured_before_first_use) {
        input.streams.stderr(
          `warning: a ticket is already admitted in ${store}, so this baseline is recorded as ` +
            "captured after first use — it is not the number to compare against\n",
        );
      }
      break;
    case "pause":
      input.streams.stdout(
        `paused ${entry.id} at ${entry.paused_at} (${formatDuration(baselineElapsedMs(entry, now))} so far)\n`,
      );
      break;
    case "resume":
      input.streams.stdout(
        `resumed ${entry.id} (${formatDuration(entry.paused_ms)} paused in total)\n`,
      );
      break;
    case "stop":
      input.streams.stdout(
        `completed ${entry.id} "${entry.title}": ${formatDuration(entry.elapsed_ms ?? 0)} ` +
          `(${formatDuration(entry.paused_ms)} paused)` +
          (entry.pull_request_url ? ` → ${entry.pull_request_url}` : "") +
          "\n",
      );
      break;
    case "abandon":
      input.streams.stdout(
        `abandoned ${entry.id} "${entry.title}" after ${formatDuration(entry.elapsed_ms ?? 0)}` +
          (entry.note ? `: ${entry.note}` : "") +
          "\n",
      );
      break;
  }
  return 0;
}

/**
 * What `perbo escapes` reads of the same file: where it is, and the schema it
 * parses a store's baseline with.
 */
export { baselinePath } from "./internal/file.js";
export { BaselineFileSchema, type BaselineFile } from "./internal/stopwatch.js";
