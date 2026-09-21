import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DOGFOOD_ANSWERER,
  EXIT_CODES,
  StopVerdictsSchema,
  TicketKeySchema,
  stateDir,
  type StopRouting,
  type Ticket,
} from "@perbo/contracts";
import { z } from "zod";
import { UsageError, readInput } from "../../usage-error.js";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../../command-line/grammar.js";
import {
  buildInspectReport,
  buildReportForSubject,
  ticketSubject,
  type InspectSubject,
  type ResolveSubject,
} from "../inspect.js";
import { pad } from "../../text.js";
import { refuseUnknownReview, storedReviewSubject, storedReviewsFor } from "../review/stored.js";
import type { CommandContext, Rendered } from "../../command.js";
import type { ReportCommand } from "../../command-line/table.js";
import { StoreTargetSchema, storeDir } from "../../store/index.js";
import { listTickets } from "../../store/tickets.js";
import {
  GIT_IDENTITY_COMMANDS,
  LOCAL_VERDICTS_SCHEMA_VERSION,
  LocalVerdictsSchema,
  VerdictConflictError,
  authorIdentity,
  authorLine,
  decidedBy,
  isStopDecision,
  readGitIdentity,
  readLocalVerdicts,
  recordVerdict,
  verdictFor,
  verdictsPath,
  writeLocalVerdicts,
  VERDICT_DECISIONS,
  type LocalVerdict,
  type VerdictDecision,
} from "./record.js";

/**
 * `perbo verdict` — a person answers a review from the command line (SCP-181).
 *
 * Today a stop is answered by ticking one of two boxes on the pull request and
 * read back by `perbo sync` through `gh`. That is the only way there is, and
 * it needs a pull request, a network and a credential for a decision that is
 * about this checkout and nobody else. This command is the same answer, taken
 * here: `--endorse`/`--override` for a stop, `--accept`/`--reject` for any
 * finding, written to `<store>/verdicts.json` with who, when and why.
 *
 * Nothing in it leaves the machine, and nothing in it asks the network — the
 * findings it resolves a key against are already on disk: the review artifacts
 * in the bundles, the executor's declines, the stops record `sync` left behind,
 * and the reviews in `<store>/reviews/` that `perbo review` wrote for a change
 * nothing ran here.
 *
 * The key is the join. It is the finding key — `hash(rule_id | criterion_id |
 * file | symbol)` — which is exactly what the checkbox marker carries, so a
 * stop endorsed here and a stop endorsed on the pull request are one decision
 * about one finding rather than two records nobody can reconcile.
 *
 * A decision taken on this machine about this checkout is local by definition.
 * What a reference a person typed names — a ticket key, the pull request the
 * ticket is behind, or the id of a review that ran on it — is resolved by
 * {@link ticketReviewSubject} against the ticket store.
 */

/** What every invocation carries, whichever of the two it is. */
const VerdictCommonSchema = {
  target: StoreTargetSchema,
  /** The change: a ticket key, a pull request (url or number), or a review id. */
  reference: z.string().min(1),
};

export const VerdictInputSchema = z.discriminatedUnion("list", [
  /** Taking a decision, which is what this command was built to do. */
  z.strictObject({
    ...VerdictCommonSchema,
    list: z.literal(false),
    decision: z.enum(VERDICT_DECISIONS),
    /** The finding key, whole or by any unambiguous prefix. */
    key: z.string().min(1),
    note: z.string().nullable(),
    author: z.string().nullable(),
    replace: z.boolean(),
    /**
     * `--stand-in`: the AI acting as the founder's partner took this decision,
     * not a person (D-058). It is recorded on the row and keeps the answer out
     * of every partner reading `perbo stops` prints — the same label the pull
     * request carries when the stand-in signs a tick there.
     */
    standIn: z.boolean(),
  }),
  /** `--list`: reading back the decisions already taken, and taking none. */
  z.strictObject({ ...VerdictCommonSchema, list: z.literal(true) }),
]);
export type VerdictInput = z.infer<typeof VerdictInputSchema>;
export type VerdictRecordInput = Extract<VerdictInput, { list: false }>;
export type VerdictListInput = Extract<VerdictInput, { list: true }>;

/** The four decisions, each spelled as the flag that takes it. */
const DECISION_FLAGS = {
  "--endorse": "endorse",
  "--override": "override",
  "--accept": "accept",
  "--reject": "reject",
} as const satisfies Record<`--${string}`, VerdictDecision>;

type DecisionFlag = keyof typeof DECISION_FLAGS;

const isDecisionFlag = (name: string): name is DecisionFlag => name in DECISION_FLAGS;

/**
 * SCP-189: a decision flag refuses a value that is missing or starts with
 * `--`, because there it is another flag whose own value the person forgot
 * rather than a key — and a key taken from it would be reported later as
 * something else entirely, or as a positional count naming no flag at all.
 */
const decisionFlag = (name: DecisionFlag) => valueFlag({ refuseFlagShaped: `missing key after ${name}` });

const VERDICT_FLAGS = {
  "--endorse": decisionFlag("--endorse"),
  "--override": decisionFlag("--override"),
  "--accept": decisionFlag("--accept"),
  "--reject": decisionFlag("--reject"),
  "--note": valueFlag(),
  "--author": valueFlag(),
  "--replace": switchFlag(),
  "--stand-in": switchFlag(),
  "--list": switchFlag(),
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

const VERDICT_GRAMMAR: Grammar<typeof VERDICT_FLAGS> = {
  command: "verdict",
  flags: VERDICT_FLAGS,
  positionals: {
    min: 1,
    max: 1,
    refusal:
      "verdict takes exactly one review — a ticket key, a pull request or a review id, " +
      "e.g. perbo verdict PRB-7 --override <key>",
  },
  afterDoubleDash: "positionals",
};

function readVerdict(argv: readonly string[]): {
  input: VerdictInput;
  output: { json: boolean };
} {
  const line = parseArgv(VERDICT_GRAMMAR, argv);
  const flags = line.flags;

  // Two decisions in one invocation is a person meaning one of them, and
  // guessing which is how a record stops being evidence. Read from the order
  // they were written, so the refusal names the two that were.
  const decisions = line.given.filter(isDecisionFlag);
  if (decisions.length > 1) {
    throw new UsageError(`${decisions[0]} and ${decisions[1]} are two decisions; take one at a time`);
  }
  const taken = decisions[0] ?? null;

  const note = flags["--note"] ?? null;
  const author = flags["--author"] ?? null;
  const replace = flags["--replace"] === true;
  const standIn = flags["--stand-in"] === true;
  const common = {
    reference: line.positionals[0]!,
    target: { repo: flags["--repo"] ?? ".", store: flags["--store"] ?? null },
  };
  const output = { json: flags["--json"] === true };

  if (flags["--list"] === true) {
    // `--list` reads the record; the flags that write to it have nothing to do
    // here. Refused rather than ignored, because a person who typed a note
    // beside `--list` believed they were recording something.
    if (taken !== null) {
      throw new UsageError(
        `--list prints the decisions already recorded and ${taken} takes one; ask for one or the other`,
      );
    }
    const writing = [
      note === null ? null : "--note",
      author === null ? null : "--author",
      replace ? "--replace" : null,
      standIn ? "--stand-in" : null,
    ].filter((flag): flag is string => flag !== null);
    if (writing.length > 0) {
      throw new UsageError(`${writing.join(" and ")} belong to taking a decision; --list only reads`);
    }
    return { input: readInput(VerdictInputSchema, { list: true, ...common }), output };
  }
  if (taken === null) {
    throw new UsageError(
      "verdict needs one decision: --endorse or --override <stop key>, or --accept or " +
        "--reject <finding key>",
    );
  }
  if (note !== null && note.trim() === "") {
    throw new UsageError("--note requires text; leave it out to record no note");
  }
  return {
    input: readInput(VerdictInputSchema, {
      ...common,
      list: false,
      decision: DECISION_FLAGS[taken],
      key: flags[taken]!,
      note,
      author,
      replace,
      standIn,
    }),
    output,
  };
}

/**
 * A finding this store knows about, and where it was read from. `routing` is
 * the stop it is; `null` for a finding that stopped nothing, which can be
 * accepted or rejected but never endorsed or overridden.
 */
export interface KnownFinding {
  finding_key: string;
  rule_id: string;
  routing: StopRouting | null;
  source: string;
}

/** The review's routings, as the stops record spells them (SCP's `declined` is not one). */
function stopRoutingOf(routing: string): StopRouting | null {
  return routing === "blocks" || routing === "escalates" ? routing : null;
}

/**
 * SCP-189: the `rule_id` a decline names when nothing else did — a `Decline`
 * carries only the finding key and the executor's reason, and the review that
 * would have named the rule is exactly what pruning takes first.
 */
const DECLINED_RULE_UNRECORDED = "declined (rule not recorded)";

/**
 * Every finding of one piece of work this store can name, by key.
 *
 * Four sources, read in the order that makes the last one right: the reviews in
 * `<store>/reviews/` say what `perbo review` found on a change nobody ran here
 * (SCP-249); the review artifacts in the bundles say what a run's own reviewer
 * found; the executor's declines say which of those it declared no determinable
 * practice for, which is the third routing that stops for a person; and the
 * stops record `sync` wrote says what the pull request actually listed, which is
 * the one place the routing has already been decided by the path this command is
 * joining.
 *
 * The reviews directory is read first for that reason: where a run and a
 * separate `review` both judged the same change, the run's own record and the
 * pull request still have the last word about a finding they name too.
 *
 * A decline resolves on its own even where the review artifact's bytes were
 * not retained: the finding is still `declined` and still decidable, from the
 * attempt's own record of the decline rather than from a rule name pruning has
 * already taken.
 */
export function knownFindings(dir: string, subject: InspectSubject): KnownFinding[] {
  const found = new Map<string, KnownFinding>();
  for (const review of storedReviewsFor(dir, subject.ticket_id)) {
    for (const finding of review.artifact.findings) {
      found.set(finding.key, {
        finding_key: finding.key,
        rule_id: finding.rule_id,
        routing: stopRoutingOf(finding.routing),
        source: `the review ${review.review_id}`,
      });
    }
  }
  const report = buildReportForSubject({ storeDirectory: dir, subject, attempt: null });
  for (const attempt of report.attempts) {
    for (const finding of attempt.review?.findings ?? []) {
      found.set(finding.key, {
        finding_key: finding.key,
        rule_id: finding.rule_id,
        routing: stopRoutingOf(finding.routing),
        source: "the review artifact",
      });
    }
    for (const decline of attempt.declines) {
      const prior = found.get(decline.finding_key);
      found.set(decline.finding_key, {
        finding_key: decline.finding_key,
        rule_id: prior?.rule_id ?? DECLINED_RULE_UNRECORDED,
        routing: "declined",
        source: prior?.source ?? "the executor's decline",
      });
    }
  }
  for (const stop of readStopsRecord(dir, subject.ticket_id)) {
    found.set(stop.finding_key, {
      finding_key: stop.finding_key,
      rule_id: stop.rule_id,
      routing: stop.routing,
      source: "the pull request",
    });
  }
  return [...found.values()];
}

/** The stops `perbo sync` read off the pull request; none, where it never ran. */
function readStopsRecord(dir: string, ticket_id: string): Array<{
  finding_key: string;
  rule_id: string;
  routing: StopRouting;
}> {
  const path = join(dir, ...stateDir(), `${ticket_id}.stops.json`);
  if (!existsSync(path)) return [];
  try {
    return StopVerdictsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).stops;
  } catch {
    // Unreadable here is not fatal: the artifacts above still name the
    // findings, and `perbo stops` is where a broken stops record is reported.
    return [];
  }
}

/** The finding a key names, whole or by any prefix that names one finding. */
export function resolveFindingKey(findings: readonly KnownFinding[], key: string): KnownFinding {
  const wanted = key.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(wanted)) {
    throw new UsageError(`'${key}' is not a finding key: they are lowercase hex, as inspect prints them`);
  }
  const exact = findings.find((finding) => finding.finding_key === wanted);
  if (exact !== undefined) return exact;
  const matches = findings.filter((finding) => finding.finding_key.startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new UsageError(
      `'${key}' names ${matches.length} findings (${matches
        .map((finding) => `${finding.finding_key.slice(0, 12)} ${finding.rule_id}`)
        .join(", ")}); give more of the key`,
    );
  }
  throw new UsageError(
    findings.length === 0
      ? `no findings are recorded for this review, so '${key}' cannot be one: ` +
          // `inspect` rather than `sync`: it is what shows whether this
          // store holds the bundles the findings would have been read from.
          "`perbo inspect` shows what this store holds for it"
      : `'${key}' is not a finding on this review. Its ${findings.length} finding(s): ${findings
          .map((finding) => `${finding.finding_key.slice(0, 12)} ${finding.rule_id}`)
          .join(", ")}`,
  );
}

/**
 * The refusal when nobody is named: this repository has neither `user.name`
 * nor `user.email`, and no `--author` was given.
 *
 * A decision is evidence about who decided, and a record that names nobody is
 * not that. So nothing is written, the exit is non-zero, and the message is the
 * two lines to run — the same two git asks for before it will let a commit be
 * made, which is the point: this needs no account and no token beyond what
 * committing to the repository already needs.
 */
function refuseUnnamed(repositoryRoot: string, json: boolean): Rendered {
  if (json) {
    return {
      stdout: `${JSON.stringify(
        { refused: true, reason: "no author", repository: repositoryRoot, set: [...GIT_IDENTITY_COMMANDS] },
        null,
        2,
      )}\n`,
      stderr: "",
      exitCode: EXIT_CODES.usage_or_input_error,
    };
  }
  return {
    stdout: "",
    stderr:
      `nothing was recorded: ${repositoryRoot} names nobody to record the decision against. ` +
      "Set the identity git already asks you for and decide again:\n" +
      `${GIT_IDENTITY_COMMANDS.map((command) => `      ${command}\n`).join("")}` +
      "  or name whoever decided with --author.\n",
    exitCode: EXIT_CODES.usage_or_input_error,
  };
}

/**
 * Who took a decision, as the record itself says: the typed pair, where the
 * record carries one.
 *
 * `author` is a line somebody wrote — this checkout's git identity run
 * together, or whatever prose `--author` gave — and a row written before
 * `decided_by` existed carries only that. So a listing that has no pair says
 * so in as many words rather than printing the prose as though the record had
 * named a person and an address: what is missing here is missing from the
 * record, and a reader should be able to see which rows those are.
 */
function whoDecided(row: LocalVerdict): string {
  return row.decided_by === undefined ? "not recorded" : `${row.decided_by.name} <${row.decided_by.email}>`;
}

/**
 * `perbo verdict --list <change>` — what has already been decided here.
 *
 * Newest first, because the question a person asks of this record is "where
 * did we get to", and superseded rows are shown too and marked: a decision
 * that was replaced is part of the answer to "did we change our mind", which
 * is the reason the file keeps it (SCP-181).
 *
 * Only the rows of the change asked about, joined on `ticket_id` — the same
 * join `verdictFor` uses, so `--list` and every other reader of this file
 * agree about which decisions belong to which work.
 */
function renderListing(report: VerdictListed, json: boolean): Rendered {
  const { recorded, subject, reference, path } = report;
  const out: string[] = [];
  const err: string[] = [];
  const streams = { stdout: (chunk: string) => out.push(chunk), stderr: (chunk: string) => err.push(chunk) };

  if (json) {
    // The rows as the file holds them: same fields, same order, nothing
    // computed and nothing dropped, in the shape `verdicts.json` itself has —
    // so a caller can diff this against the file and see only the narrowing to
    // one change. The order a person reads them in is a rendering, and belongs
    // to the text below rather than to the record.
    streams.stdout(
      `${JSON.stringify(
        LocalVerdictsSchema.parse({
          schema_version: LOCAL_VERDICTS_SCHEMA_VERSION,
          verdicts: recorded,
        }),
        null,
        2,
      )}\n`,
    );
    return { stdout: out.join(""), stderr: err.join(""), exitCode: EXIT_CODES.approve };
  }

  if (recorded.length === 0) {
    streams.stdout("no decisions recorded\n");
    streams.stderr(
      `  nothing has been decided here about ${subject.ticket}. ` +
        `\`perbo verdict ${reference} --endorse|--override|--accept|--reject <key>\` ` +
        // Not `inspect`, which reads the attempts a run left and so has nothing
        // to say about a review no run filed. The command being typed here
        // knows every finding of either, and says so when a key is not one.
        "takes one, and refuses a key it does not know by naming every finding on this review\n",
    );
    return { stdout: out.join(""), stderr: err.join(""), exitCode: EXIT_CODES.approve };
  }

  // A decision that replaced an earlier one is stamped on the row it replaced,
  // never on itself, so `superseded_at` is exactly "this is not what stands".
  const shown = recorded.map((row) => ({
    row,
    decision: row.superseded_at === null ? row.decision : `${row.decision} (replaced)`,
  }));
  const width = Math.max(...shown.map((line) => line.decision.length));
  // Newest first by when it was taken, and — for two taken in the same
  // instant, which `--replace` in a script can produce — the later-written row
  // first, which is what reversing before the stable sort gives.
  const newestFirst = [...shown]
    .reverse()
    .sort((a, b) => Date.parse(b.row.decided_at) - Date.parse(a.row.decided_at));
  for (const line of newestFirst) {
    streams.stdout(
      `${line.row.decided_at}  ${line.row.finding_key.slice(0, 12)}  ` +
        `${pad(line.decision, width)}  ${whoDecided(line.row)}\n`,
    );
  }
  const standing = recorded.filter((row) => row.superseded_at === null).length;
  streams.stderr(
    `  ${subject.ticket}: ${recorded.length} decision(s), ${standing} standing; ` +
      "a replaced one is kept and marked\n" +
      `  ${path} — this machine only; nothing was sent anywhere\n`,
  );
  return { stdout: out.join(""), stderr: err.join(""), exitCode: EXIT_CODES.approve };
}

/** The pull request number a reference names, whichever way it was written. */
function pullRequestNumber(reference: string): number | null {
  const plain = /^#?(\d+)$/.exec(reference);
  if (plain) return Number(plain[1]);
  const inUrl = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(reference);
  return inUrl ? Number(inUrl[1]) : null;
}

/**
 * The ticket a reference names. A ticket key first, then the pull request —
 * by url as the ticket recorded it, then by number — and then a review id,
 * which costs a read of every ticket's bundles and so is asked last.
 */
export function resolveReview(dir: string, reference: string): Ticket {
  const tickets = listTickets(dir);
  const byKey = tickets.find((ticket) => ticket.key === reference);
  if (byKey !== undefined) return byKey;

  const byUrl = tickets.filter((ticket) => ticket.delivery.pull_request_url === reference);
  if (byUrl.length > 0) return one(byUrl, reference, "pull request");

  const number = pullRequestNumber(reference);
  if (number !== null) {
    const byNumber = tickets.filter((ticket) => ticket.delivery.pull_request_number === number);
    if (byNumber.length > 0) return one(byNumber, reference, "pull request");
  }

  if (reference.startsWith("rev_")) {
    const byReview = tickets.filter((ticket) =>
      buildInspectReport({ storeDirectory: dir, key: ticket.key, attempt: null }).attempts.some(
        (attempt) =>
          attempt.review?.review_id === reference ||
          attempt.bundles.some((bundle) => bundle.subject_id === reference),
      ),
    );
    if (byReview.length > 0) return one(byReview, reference, "review");
  }

  throw new UsageError(
    `no review in ${dir} is '${reference}': it matches no ticket key, no pull request on a ` +
      `ticket and no review id. \`perbo list --all\` names the tickets this store holds`,
  );
}

function one(matches: readonly Ticket[], reference: string, what: string): Ticket {
  if (matches.length === 1) return matches[0]!;
  throw new UsageError(
    `${what} '${reference}' is on ${matches.length} tickets (${matches
      .map((ticket) => ticket.key)
      .join(", ")}); name the one you mean by its key`,
  );
}

/** The work a reference names, as the report and the record need it. */
export const ticketReviewSubject: ResolveSubject = (dir, reference): InspectSubject =>
  ticketSubject(dir, resolveReview(dir, reference).key);

/** What a verdict is given beyond its input. */
export interface VerdictDeps {
  /**
   * How a reference a person typed becomes the work it names.
   * {@link ticketReviewSubject} unless a caller names another.
   */
  resolve: ResolveSubject;
}

/** `--list`: the rows this store holds about one change. */
export interface VerdictListed {
  readonly kind: "listed";
  readonly subject: InspectSubject;
  /** The reference as it was typed, which the advice line repeats. */
  readonly reference: string;
  readonly recorded: readonly LocalVerdict[];
  readonly path: string;
}

/** What one invocation did, or refused to do. */
export type VerdictReport =
  | VerdictListed
  /** Nothing to record the decision against: no `--author` and no git identity. */
  | { readonly kind: "unnamed"; readonly repositoryRoot: string }
  /** A decision already stands on this finding and `--replace` was not given. */
  | {
      readonly kind: "refused";
      readonly subject: InspectSubject;
      readonly existing: LocalVerdict;
      readonly message: string;
    }
  | {
      readonly kind: "recorded";
      readonly subject: InspectSubject;
      readonly verdict: LocalVerdict;
      readonly finding: KnownFinding;
      /** A decision it replaced stands on the record, superseded. */
      readonly superseded: boolean;
      readonly path: string;
    };

/**
 * The work a reference names: whatever ran here, and then what was reviewed
 * here without running (SCP-249).
 *
 * `resolve` is the store's own record, and it is asked first, so a review an
 * attempt filed resolves exactly as it always did. A review nothing ran for reaches that
 * record as a name it has never heard of, and `<store>/reviews/` is the second
 * place to look before the reference is refused: `perbo review --pr` files no
 * attempt, so the bundle it wrote is the only record its id appears in.
 *
 * Only a {@link UsageError} is caught. A store that cannot be read is a
 * different fault from a name that is not in it, and falling back on one would
 * answer a broken record with a search somewhere else.
 */
function subjectFor(dir: string, reference: string, resolve: ResolveSubject): InspectSubject {
  try {
    return resolve(dir, reference);
  } catch (unresolved) {
    if (!(unresolved instanceof UsageError)) throw unresolved;
    return storedReviewSubject(dir, reference) ?? refuseUnknownReview(dir, reference, unresolved);
  }
}

export function verdict(
  input: VerdictInput,
  context: CommandContext & Partial<VerdictDeps>,
): VerdictReport {
  const repositoryRoot = resolve(context.cwd, input.target.repo);
  const dir = storeDir(repositoryRoot, input.target.store);
  const subject = subjectFor(dir, input.reference, context.resolve ?? ticketReviewSubject);
  if (input.list) {
    // The strict reader, as the write path uses: reporting "no decisions
    // recorded" for a file this cannot parse would be a lie about the record.
    return {
      kind: "listed",
      subject,
      reference: input.reference,
      recorded: readLocalVerdicts(dir).verdicts.filter(
        (row) => row.review.ticket_id === subject.ticket_id,
      ),
      path: verdictsPath(dir),
    };
  }
  const args = input;
  const finding = resolveFindingKey(knownFindings(dir, subject), args.key);

  if (isStopDecision(args.decision) && finding.routing === null) {
    throw new UsageError(
      `--${args.decision} answers a stop, and ${finding.finding_key.slice(0, 12)} ` +
        `(${finding.rule_id}) stopped nothing — it was never put in front of a person. ` +
        "Use --accept or --reject to judge the finding itself",
    );
  }

  // Who decided. `--author` names them where it is given; otherwise the
  // repository does, through the two config lines git already asks every
  // contributor for — no account, no token. Both fields are read from whichever
  // of the two spoke, so a record can never carry an `author` from one source
  // and a `decided_by` from another.
  const identity = readGitIdentity(repositoryRoot);
  const author = args.author ?? authorLine(identity);
  if (author === null) return { kind: "unnamed", repositoryRoot };
  const decided_by = args.author === null ? decidedBy(identity) : authorIdentity(args.author);

  // `subject.ticket` is what a person calls this work (`InspectSubject.ticket`).
  // The record carries it as the ticket key where it is one and `null` where it
  // is not, rather than inventing a key nothing minted.
  const key = TicketKeySchema.safeParse(subject.ticket);
  const taking: LocalVerdict = {
    review: {
      reference: args.reference,
      ticket_id: subject.ticket_id,
      ticket_key: key.success ? key.data : null,
      pull_request_url: subject.pull_request_url,
    },
    finding_key: finding.finding_key,
    rule_id: finding.rule_id,
    routing: finding.routing,
    decision: args.decision,
    author,
    // Absent rather than null where nobody typed it: a store written before
    // this field existed carries none, and a new record with nothing to put in
    // it should read the same way to everything that reads them both.
    ...(decided_by === null ? {} : { decided_by }),
    // The same rule for the same reason: absent is a person, which is what
    // every row written at this command line before `--stand-in` existed was.
    ...(args.standIn ? { answered_by: DOGFOOD_ANSWERER } : {}),
    decided_at: context.now.toISOString(),
    note: args.note,
    superseded_at: null,
  };

  // Read before the write and written whole: a refusal below leaves the file
  // exactly as it was, which is what makes a refused second decision safe.
  const previous = readLocalVerdicts(dir);
  const standing = verdictFor(previous.verdicts, subject.ticket_id, finding.finding_key);
  let next;
  try {
    next = recordVerdict({ previous, verdict: taking, replace: args.replace });
  } catch (error) {
    if (!(error instanceof VerdictConflictError)) throw error;
    return { kind: "refused", subject, existing: error.existing, message: error.message };
  }
  writeLocalVerdicts(dir, next);

  return {
    kind: "recorded",
    subject,
    verdict: taking,
    finding,
    superseded: standing !== null,
    path: verdictsPath(dir),
  };
}

/**
 * What one decision looks like once it is taken, and what a refusal looks
 * like: the same two answers whether a person is reading them or a script is.
 */
function renderVerdict(report: VerdictReport, json: boolean): Rendered {
  if (report.kind === "listed") return renderListing(report, json);
  if (report.kind === "unnamed") return refuseUnnamed(report.repositoryRoot, json);
  if (report.kind === "refused") {
    // SCP-189: a `--json` caller asked for machine-readable output and a
    // refusal is not an exception to that — one JSON object naming the
    // standing decision, on stdout, nothing on stderr, so "already decided"
    // reads as data rather than as the prose every other refusal prints.
    if (json) {
      return {
        stdout: `${JSON.stringify(
          {
            refused: true,
            finding_key: report.existing.finding_key,
            decision: report.existing.decision,
            author: report.existing.author,
            decided_at: report.existing.decided_at,
          },
          null,
          2,
        )}\n`,
        stderr: "",
        exitCode: EXIT_CODES.usage_or_input_error,
      };
    }
    return {
      stdout: "",
      stderr:
        `${report.subject.ticket} unchanged: ${report.message}` +
        `${report.existing.note === null ? "" : ` (${report.existing.note})`}. ` +
        "Pass --replace to decide it again; the earlier decision stays on the record.\n",
      exitCode: EXIT_CODES.usage_or_input_error,
    };
  }
  const { subject, finding, verdict: taken } = report;
  if (json) {
    return { stdout: `${JSON.stringify(taken, null, 2)}\n`, stderr: "", exitCode: EXIT_CODES.approve };
  }
  return {
    stdout:
      `${subject.ticket}  ${finding.finding_key.slice(0, 12)}  ${taken.decision}  ` +
      `${taken.author}  ${taken.decided_at}\n`,
    stderr:
      `  ${finding.rule_id} · ${finding.routing ?? "not a stop"} · read from ${finding.source}\n` +
      (taken.note === null ? "" : `  note: ${taken.note}\n`) +
      (taken.answered_by === DOGFOOD_ANSWERER
        ? "  recorded as the AI stand-in's answer: dogfood, and outside every partner reading " +
          "`perbo stops` prints (D-058)\n"
        : "") +
      (report.superseded ? "  the decision it replaces stays on the record, superseded\n" : "") +
      `  ${report.path} — this machine only; nothing was sent anywhere\n`,
    exitCode: EXIT_CODES.approve,
  };
}

export const verdictCommandLine: ReportCommand<
  VerdictInput,
  { json: boolean },
  VerdictReport,
  VerdictDeps
> = {
  kind: "report",
  name: "verdict",
  grammars: [VERDICT_GRAMMAR],
  jsonWhenPiped: false,
  grammarFor: () => VERDICT_GRAMMAR,
  read: readVerdict,
  run: verdict,
  render: (report, _output, target) => renderVerdict(report, target.json),
};
