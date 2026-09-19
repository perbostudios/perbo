import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  E1LedgerSchema,
  E1StateError,
  E1_BASELINE_SIZE,
  E1_DEFAULT_THRESHOLDS,
  E1_LEARNING_CURVE_TICKETS,
  EMPTY_E1_LEDGER,
  e1BaselineTicket,
  e1Cohort,
  e1Report,
  e1Result,
  e1Subject,
  openE1Subject,
  recordE1BaselineTicket,
  recordE1ProductRun,
  recordE1Routing,
  sealE1Baseline,
  type E1Arm,
  type E1Defect,
  type E1Ledger,
  type E1ProductRun,
  type E1Result,
  type E1Thresholds,
} from "@perbo/contracts";
import { UsageError } from "./args.js";
import { baselinePath, readBaselineFile } from "./baseline.js";
import { formatDuration } from "./execute.js";
import { storeDir } from "./store.js";
import type { Streams } from "./streams.js";

/**
 * `perbo baseline` beyond the stopwatch: the E1 harness (D-038, SCP-080).
 *
 * `baseline.ts` times one piece of work. These six subcommands are what
 * turns a pile of readings into a claim: a partner's ten, the thresholds they
 * agreed to before any of it was measured, the seal that fixes the ten before
 * the product is ever used, the product runs of those same ten, and the
 * confounders recorded beside the ratio rather than inside it.
 *
 * The rules live in `@perbo/contracts`, which refuses what must be refused.
 * What is here is the file, the flags and the words a person reads back —
 * `<repo>/.perbo/e1.json`, on one machine like everything else `perbo`
 * touches.
 */

export const E1_FILENAME = "e1.json";

export const E1_COMMANDS = ["open", "time", "seal", "run", "routing", "result"] as const;
export type E1Command = (typeof E1_COMMANDS)[number];

export function isE1Command(token: string | undefined): token is E1Command {
  return (E1_COMMANDS as readonly string[]).includes(token ?? "");
}

export interface E1Args {
  command: E1Command;
  subject: string | null;
  arm: E1Arm;
  title: string | null;
  item: string | null;
  from: string | null;
  started: string | null;
  opened: string | null;
  interruptions: number;
  friction: number;
  abandoned: string | null;
  defects: string[];
  period: string | null;
  eligible: number | null;
  voluntary: number | null;
  onRequest: number;
  agreedOn: string | null;
  agreedWith: string | null;
  record: string | null;
  thresholds: Partial<E1Thresholds>;
  json: boolean;
  repo: string;
  store: string | null;
}

const VALUE_FLAGS = new Set([
  "--partner",
  "--item",
  "--title",
  "--from",
  "--started",
  "--opened",
  "--interruptions",
  "--friction",
  "--abandoned",
  "--defect",
  "--period",
  "--eligible",
  "--voluntary",
  "--on-request",
  "--agreed-on",
  "--agreed-with",
  "--record",
  "--ratio-ten",
  "--ratio-five",
  "--routing",
  "--abandonment",
  "--defects",
  "--repo",
  "--store",
]);

/** Every subcommand answers to these; they say where the ledger is, not what is in it. */
const WHERE = ["--repo", "--store"] as const;

/** Which flags each subcommand answers to, so a flag on the wrong one is a refusal. */
const ALLOWED: Record<E1Command, readonly string[]> = {
  open: [
    "--partner",
    "--agent",
    "--agreed-on",
    "--agreed-with",
    "--record",
    "--ratio-ten",
    "--ratio-five",
    "--routing",
    "--abandonment",
    "--defects",
    ...WHERE,
  ],
  time: [
    "--partner",
    "--item",
    "--title",
    "--from",
    "--started",
    "--opened",
    "--interruptions",
    ...WHERE,
  ],
  seal: ["--partner", ...WHERE],
  run: [
    "--partner",
    "--item",
    "--started",
    "--opened",
    "--interruptions",
    "--friction",
    "--abandoned",
    "--defect",
    ...WHERE,
  ],
  routing: ["--partner", "--period", "--eligible", "--voluntary", "--on-request", ...WHERE],
  result: ["--partner", "--json", ...WHERE],
};

const USAGE =
  `baseline ${E1_COMMANDS.join(" | ")} record the E1 comparison:\n` +
  `  open    --partner <id> [--agent] --agreed-on <date> --agreed-with "<who>" --record "<where>"\n` +
  `  time    --partner <id> --item <ID> --title "<t>" --started <iso> --opened <iso> [--interruptions <min>]\n` +
  `  time    --partner <id> --from bl_<id> [--item <ID>]\n` +
  `  seal    --partner <id>\n` +
  `  run     --partner <id> --item <ID> --started <iso> --opened <iso> [--interruptions <min>]\n` +
  `          [--friction <min>] [--abandoned "<reason>"] [--defect "<summary> :: <evidence>"]\n` +
  `  routing --partner <id> --period "<when>" --eligible <n> --voluntary <n> [--on-request <n>]\n` +
  `  result  [--partner <id>] [--json]`;

function number(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${flag} takes a number, not '${raw}'`);
  return value;
}

function minutes(flag: string, raw: string): number {
  const value = number(flag, raw);
  if (value < 0) throw new UsageError(`${flag} cannot be negative`);
  return Math.round(value * 60_000);
}

/**
 * A date the way a person writes one: `2026-08-25` is that day at midnight UTC,
 * and a full timestamp is taken as it stands. Anything else is refused rather
 * than guessed, because every date here decides whether a measurement counts.
 */
export function parseWhen(flag: string, raw: string): Date {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const when = new Date(text);
  if (Number.isNaN(when.getTime())) {
    throw new UsageError(`${flag} takes an ISO date or timestamp, not '${raw}'`);
  }
  return when;
}

export function parseE1Args(argv: readonly string[]): E1Args {
  const tokens = argv.flatMap((token) => {
    if (!token.startsWith("--")) return [token];
    const eq = token.indexOf("=");
    return eq === -1 ? [token] : [token.slice(0, eq), token.slice(eq + 1)];
  });
  const [command, ...rest] = tokens;
  if (!isE1Command(command)) throw new UsageError(USAGE);

  const args: E1Args = {
    command,
    subject: null,
    arm: "partner",
    title: null,
    item: null,
    from: null,
    started: null,
    opened: null,
    interruptions: 0,
    friction: 0,
    abandoned: null,
    defects: [],
    period: null,
    eligible: null,
    voluntary: null,
    onRequest: 0,
    agreedOn: null,
    agreedWith: null,
    record: null,
    thresholds: {},
    json: false,
    repo: ".",
    store: null,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      throw new UsageError(`baseline ${command} takes flags, not '${token}'`);
    }
    if (!ALLOWED[command].includes(token)) {
      throw new UsageError(
        VALUE_FLAGS.has(token) || token === "--json" || token === "--agent"
          ? `${token} does not apply to baseline ${command}`
          : `unknown flag '${token}'`,
      );
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--agent") {
      args.arm = "agent_direct";
      continue;
    }
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${token} requires a value`);
    switch (token) {
      case "--partner":
        args.subject = value;
        break;
      case "--item":
        args.item = value;
        break;
      case "--title":
        args.title = value;
        break;
      case "--from":
        args.from = value;
        break;
      case "--started":
        args.started = value;
        break;
      case "--opened":
        args.opened = value;
        break;
      case "--interruptions":
        args.interruptions = minutes(token, value);
        break;
      case "--friction":
        args.friction = minutes(token, value);
        break;
      case "--abandoned":
        args.abandoned = value;
        break;
      case "--defect":
        args.defects.push(value);
        break;
      case "--period":
        args.period = value;
        break;
      case "--eligible":
        args.eligible = number(token, value);
        break;
      case "--voluntary":
        args.voluntary = number(token, value);
        break;
      case "--on-request":
        args.onRequest = number(token, value);
        break;
      case "--agreed-on":
        args.agreedOn = value;
        break;
      case "--agreed-with":
        args.agreedWith = value;
        break;
      case "--record":
        args.record = value;
        break;
      case "--ratio-ten":
        args.thresholds.ratio_by_ticket_10 = number(token, value);
        break;
      case "--ratio-five":
        args.thresholds.ratio_through_ticket_5 = number(token, value);
        break;
      case "--routing":
        args.thresholds.min_voluntary_routing_rate = number(token, value);
        break;
      case "--abandonment":
        args.thresholds.max_mid_flow_abandonment_rate = number(token, value);
        break;
      case "--defects":
        args.thresholds.min_defects_caught = number(token, value);
        break;
      case "--repo":
        args.repo = value;
        break;
      case "--store":
        args.store = value;
        break;
      default:
        throw new UsageError(`unknown flag '${token}'`);
    }
  }

  if (args.command !== "result" && args.subject === null) {
    throw new UsageError(`baseline ${args.command} needs --partner <id>`);
  }
  return args;
}

export function e1Path(storeDirectory: string): string {
  return join(storeDirectory, E1_FILENAME);
}

export function readE1Ledger(path: string): E1Ledger {
  if (!existsSync(path)) return EMPTY_E1_LEDGER;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = E1LedgerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not an E1 ledger:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

function writeE1Ledger(path: string, ledger: E1Ledger): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(E1LedgerSchema.parse(ledger), null, 2)}\n`);
}

function requireFlag<T>(value: T | null, flag: string, command: E1Command): T {
  if (value === null) throw new UsageError(`baseline ${command} needs ${flag}`);
  return value;
}

/** `"<summary> :: <evidence>"`, with the evidence optional and never invented. */
function parseDefect(raw: string, work_item_id: string, now: Date): E1Defect {
  const [summary, ...rest] = raw.split(" :: ");
  if ((summary ?? "").trim() === "") {
    throw new UsageError(`--defect needs a summary, e.g. --defect "unbounded query :: <url>"`);
  }
  if (rest.length > 1) {
    throw new UsageError(`--defect takes at most one ' :: ' separator: '${raw}'`);
  }
  return {
    work_item_id,
    summary: summary!.trim(),
    evidence: rest.length === 1 && rest[0]!.trim() !== "" ? rest[0]!.trim() : null,
    recorded_at: now.toISOString(),
  };
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const times = (ratio: number | null): string => (ratio === null ? "—" : `${ratio.toFixed(2)}×`);
const duration = (ms: number | null): string => (ms === null ? "—" : formatDuration(ms));

export function renderE1Result(result: E1Result): string {
  const lines: string[] = [];
  const seal = result.baseline.sealed_at
    ? `sealed ${result.baseline.sealed_at}${result.baseline.seal_intact ? "" : " — DIGEST BROKEN"}`
    : `unsealed (${result.baseline.tickets} of ${E1_BASELINE_SIZE} timed)`;
  lines.push(`  ${result.subject_id}  ${result.arm.padEnd(12)} ${seal}`);
  if (!result.counts_toward_e1) {
    lines.push(
      "    note        an agent-direct baseline: its own result, never pooled with a partner's",
    );
  }
  lines.push(
    `    thresholds  ≤${result.thresholds.ratio_by_ticket_10}× by ticket ${E1_BASELINE_SIZE}, ` +
      `≤${result.thresholds.ratio_through_ticket_5}× through ${E1_LEARNING_CURVE_TICKETS}, ` +
      `routing ≥${percent(result.thresholds.min_voluntary_routing_rate)}, ` +
      `abandonment <${percent(result.thresholds.max_mid_flow_abandonment_rate)}, ` +
      `≥${result.thresholds.min_defects_caught} defect(s)`,
    `                agreed ${result.thresholds.agreed_at} with ${result.thresholds.agreed_with}` +
      ` — ${result.thresholds.record}`,
    `    baseline    ${result.baseline.tickets} ticket(s) · ` +
      `median ${duration(result.baseline.median_elapsed_ms)}`,
    `    ratio       ${times(result.ratio.ratio)} over ${result.ratio.matched} of ${E1_BASELINE_SIZE}` +
      ` (product ${duration(result.ratio.product_median_ms)} against ` +
      `${duration(result.ratio.baseline_median_ms)} on the same tickets)`,
    `                through ticket ${E1_LEARNING_CURVE_TICKETS}: ${times(result.ratio.through_ticket_5.ratio)}` +
      ` over ${result.ratio.through_ticket_5.matched}`,
  );
  if (result.ratio.excluded_work_item_ids.length > 0) {
    lines.push(
      `                excluded: ${result.ratio.excluded_work_item_ids.join(", ")} (not one of the sealed ten)`,
    );
  }
  const confounders = result.confounders;
  const abandonment =
    confounders.mid_flow_abandonment_rate === null
      ? "—"
      : percent(confounders.mid_flow_abandonment_rate);
  const routing =
    confounders.voluntary_routing_rate === null
      ? "not observed"
      : `${percent(confounders.voluntary_routing_rate)} ` +
        `(${confounders.routing_voluntary}/${confounders.routing_eligible})`;
  lines.push(
    `    beside it   admission friction ${duration(confounders.admission_friction_total_ms)} total · ` +
      `mid-flow abandonment ${abandonment} · voluntary routing ${routing}`,
    `                defects caught ${confounders.defects_caught.length} · ` +
      `abandonment reasons ${confounders.abandonment_reasons.length}` +
      " — recorded beside the ratio, never inside it",
  );
  for (const defect of confounders.defects_caught) {
    lines.push(
      `                  ${defect.work_item_id}  ${defect.summary}` +
        (defect.evidence ? `  ${defect.evidence}` : ""),
    );
  }
  lines.push(`    verdict     ${result.verdict}`);
  for (const reason of result.reasons) lines.push(`                  - ${reason}`);
  return lines.join("\n");
}

export function renderE1Report(ledger: E1Ledger, path: string): string {
  const report = e1Report(ledger);
  const lines = [`E1  ${path}`];
  if (report.partners.length === 0 && report.agent_direct.length === 0) {
    lines.push("  no baseline is open here yet: perbo baseline open --partner <id> …");
    return lines.join("\n");
  }
  if (report.partners.length > 0) {
    lines.push("", "PARTNERS");
    for (const result of report.partners) lines.push(renderE1Result(result));
    const cohort = e1Cohort(report.partners);
    lines.push(
      "",
      `  cohort      ${cohort.passing} of ${cohort.partners} partner(s) pass · ` +
        `${cohort.routing_at_threshold} routing at or over their agreed rate ` +
        "(the comparison wants four of six)",
    );
  }
  if (report.agent_direct.length > 0) {
    lines.push("", "AGENT-DIRECT (reported on its own; no part of any partner's number)");
    for (const result of report.agent_direct) lines.push(renderE1Result(result));
  }
  return lines.join("\n");
}

export interface E1Options {
  argv: string[];
  streams: Streams;
  cwd: string;
  now?: () => Date;
}

export async function runE1Command(input: E1Options): Promise<number> {
  const args = parseE1Args(input.argv);
  const now = (input.now ?? (() => new Date()))();
  const store = storeDir(resolve(input.cwd, args.repo), args.store);
  const path = e1Path(store);
  const before = readE1Ledger(path);

  if (args.command === "result") {
    const ledger = args.subject
      ? { ...before, subjects: before.subjects.filter((one) => one.subject_id === args.subject) }
      : before;
    if (args.subject && ledger.subjects.length === 0) {
      throw new UsageError(`no baseline is open for ${args.subject} in ${path}`);
    }
    if (args.json || !input.streams.isTTY) {
      const report = e1Report(ledger);
      input.streams.stdout(
        `${JSON.stringify(
          {
            path,
            ...report,
            // The cohort read is over partners; the stand-in's arm is beside it
            // and never in it (SCP-080).
            cohort: e1Cohort(report.partners),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      input.streams.stdout(`${renderE1Report(ledger, path)}\n`);
    }
    return 0;
  }

  const subject = args.subject!;
  let after: E1Ledger;
  try {
    after = apply(before, args, subject, store, now);
  } catch (error) {
    if (error instanceof E1StateError) throw new UsageError(error.message);
    throw error;
  }
  writeE1Ledger(path, after);
  input.streams.stdout(`${announce(args, subject, after, now)}\n`);
  return 0;
}

function apply(
  ledger: E1Ledger,
  args: E1Args,
  subject: string,
  store: string,
  now: Date,
): E1Ledger {
  switch (args.command) {
    case "open": {
      const agreedOn = requireFlag(args.agreedOn, "--agreed-on <date>", "open");
      return openE1Subject(ledger, {
        subject_id: subject,
        arm: args.arm,
        thresholds: {
          ...E1_DEFAULT_THRESHOLDS,
          ...args.thresholds,
          agreed_at: parseWhen("--agreed-on", agreedOn).toISOString(),
          agreed_with: requireFlag(args.agreedWith, '--agreed-with "<who>"', "open"),
          record: requireFlag(args.record, '--record "<where>"', "open"),
        },
        now,
      });
    }
    case "time":
      return recordE1BaselineTicket(ledger, subject, baselineTicketFor(args, store, now));
    case "seal":
      return sealE1Baseline(ledger, subject, now);
    case "run":
      return recordE1ProductRun(ledger, subject, productRunFor(args, now));
    case "routing":
      return recordE1Routing(ledger, subject, {
        period: requireFlag(args.period, '--period "<when>"', "routing"),
        eligible: requireFlag(args.eligible, "--eligible <n>", "routing"),
        routed_voluntarily: requireFlag(args.voluntary, "--voluntary <n>", "routing"),
        routed_on_request: args.onRequest,
        observed_at: now.toISOString(),
      });
    default:
      throw new UsageError(USAGE);
  }
}

/**
 * A reading, either typed or taken from the stopwatch.
 *
 * `--from` is the whole reason the stopwatch and the ledger are one command:
 * the entry already holds the two times and the pauses the person reported
 * while they worked, so re-typing them is a chance to get them wrong.
 */
function baselineTicketFor(args: E1Args, store: string, now: Date) {
  if (args.from !== null) {
    if (args.started !== null || args.opened !== null) {
      throw new UsageError("--from takes the times from the stopwatch entry; drop --started/--opened");
    }
    const file = readBaselineFile(baselinePath(store));
    const entry = file.entries.find((candidate) => candidate.id === args.from);
    if (!entry) throw new UsageError(`no stopwatch entry ${args.from} in ${baselinePath(store)}`);
    if (entry.outcome !== "completed" || entry.ended_at === null) {
      throw new UsageError(
        `${entry.id} "${entry.title}" is ${entry.outcome ?? "still running"}: only a completed ` +
          "reading is a baseline ticket",
      );
    }
    return e1BaselineTicket({
      work_item_id: args.item ?? entry.ref ?? entry.id,
      title: args.title ?? entry.title,
      work_started_at: new Date(entry.started_at),
      pull_request_opened_at: new Date(entry.ended_at),
      interruption_ms: entry.paused_ms,
      source: "stopwatch",
      stopwatch_id: entry.id,
      recorded_at: now,
    });
  }
  return e1BaselineTicket({
    work_item_id: requireFlag(args.item, "--item <ID>", "time"),
    title: requireFlag(args.title, '--title "<t>"', "time"),
    work_started_at: parseWhen("--started", requireFlag(args.started, "--started <iso>", "time")),
    pull_request_opened_at: parseWhen("--opened", requireFlag(args.opened, "--opened <iso>", "time")),
    interruption_ms: args.interruptions,
    source: "reported",
    stopwatch_id: null,
    recorded_at: now,
  });
}

function productRunFor(args: E1Args, now: Date): E1ProductRun {
  const work_item_id = requireFlag(args.item, "--item <ID>", "run");
  const started = parseWhen("--started", requireFlag(args.started, "--started <iso>", "run"));
  const defects = args.defects.map((raw) => parseDefect(raw, work_item_id, now));
  if (args.abandoned !== null) {
    if (args.opened !== null) {
      throw new UsageError("an abandoned run has no pull request: drop --opened or --abandoned");
    }
    return {
      work_item_id,
      work_started_at: started.toISOString(),
      pull_request_opened_at: null,
      interruption_ms: args.interruptions,
      wall_clock_ms: null,
      elapsed_ms: null,
      admission_friction_ms: args.friction,
      abandoned_mid_flow: true,
      abandonment_reason: args.abandoned,
      defects_caught: defects,
      recorded_at: now.toISOString(),
    };
  }
  const opened = parseWhen("--opened", requireFlag(args.opened, "--opened <iso>", "run"));
  const wall_clock_ms = opened.getTime() - started.getTime();
  return {
    work_item_id,
    work_started_at: started.toISOString(),
    pull_request_opened_at: opened.toISOString(),
    interruption_ms: args.interruptions,
    wall_clock_ms,
    elapsed_ms: wall_clock_ms - args.interruptions,
    admission_friction_ms: args.friction,
    abandoned_mid_flow: false,
    abandonment_reason: null,
    defects_caught: defects,
    recorded_at: now.toISOString(),
  };
}

function announce(args: E1Args, subject_id: string, ledger: E1Ledger, now: Date): string {
  const after = e1Subject(ledger, subject_id)!;
  switch (args.command) {
    case "open":
      return (
        `opened ${subject_id} (${after.arm}) with thresholds agreed ${after.thresholds.agreed_at} ` +
        `with ${after.thresholds.agreed_with}` +
        (after.arm === "agent_direct"
          ? "\nthis is an agent-direct baseline: it is reported on its own and pooled with no partner's"
          : "")
      );
    case "time": {
      const ticket = after.tickets[after.tickets.length - 1]!;
      const short = E1_BASELINE_SIZE - after.tickets.length;
      return (
        `timed ${ticket.work_item_id} "${ticket.title}": ${formatDuration(ticket.elapsed_ms)} ` +
        `(${formatDuration(ticket.wall_clock_ms)} on the clock, ` +
        `${formatDuration(ticket.interruption_ms)} interrupted)` +
        (short > 0
          ? `\n${after.tickets.length} of ${E1_BASELINE_SIZE}; ${short} to go before it can be sealed`
          : `\n${E1_BASELINE_SIZE} of ${E1_BASELINE_SIZE}: seal it before this partner's first run`)
      );
    }
    case "seal":
      return (
        `sealed ${subject_id}'s baseline at ${after.seal!.sealed_at}: ` +
        `${E1_BASELINE_SIZE} tickets, ` +
        `median ${formatDuration(e1Result(after).baseline.median_elapsed_ms ?? 0)}\n` +
        `digest ${after.seal!.digest}\nnothing may be added to it, and nothing in it may change`
      );
    case "run": {
      const run = after.runs[after.runs.length - 1]!;
      const result = e1Result(after);
      const sealed = after.seal!.work_item_ids.includes(run.work_item_id);
      return (
        (run.abandoned_mid_flow
          ? `recorded ${run.work_item_id} abandoned mid-flow: ${run.abandonment_reason}`
          : `recorded ${run.work_item_id} through the product: ${formatDuration(run.elapsed_ms!)}`) +
        (sealed
          ? `\nratio ${times(result.ratio.ratio)} over ${result.ratio.matched} of ${E1_BASELINE_SIZE}`
          : `\n${run.work_item_id} is not one of the sealed ten: recorded, and no part of the ratio`)
      );
    }
    case "routing": {
      const observation = after.routing[after.routing.length - 1]!;
      return (
        `recorded ${observation.routed_voluntarily} of ${observation.eligible} eligible items ` +
        `routed voluntarily in ${observation.period} (${percent(observation.routed_voluntarily / observation.eligible)})`
      );
    }
    default:
      return `recorded at ${now.toISOString()}`;
  }
}
