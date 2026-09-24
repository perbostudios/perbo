import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  STOP_VERDICTS_SCHEMA_VERSION,
  StopAnswererSchema,
  StopFindingKeySchema,
  StopRoutingSchema,
  StopVerdictsSchema,
  TicketIdSchema,
  TicketKeySchema,
  type StopVerdict,
  type StopVerdicts,
} from "@perbo/contracts";
import { git, replaceFile } from "@perbo/workspace";
import type { Diagnostics } from "../../diagnostics.js";

/**
 * Local verdicts: the decision a person took at the command line, recorded on
 * this machine and nowhere else (SCP-181, under D-075/ADR-0032 — the local CLI
 * is open, and anything that remembers beyond one machine is paid).
 *
 * A stop is answered today by ticking one of two boxes on the pull request,
 * which `perbo sync` reads back through `gh`. That path needs a pull request,
 * a network and a credential. `perbo verdict` is the same answer taken here:
 * `--endorse`/`--override` answer a stop exactly as the boxes do, and
 * `--accept`/`--reject` judge any finding, stop or not.
 *
 * The two paths meet at the **finding key** — `hash(rule_id | criterion_id |
 * file | symbol)`, the same value the checkbox marker carries — so a decision
 * taken either way names the same finding, and `mergeLocalVerdicts` below is
 * what lets `perbo stops` count them as one population.
 *
 * The file is append-only in the sense that matters: replacing a decision
 * supersedes the earlier row rather than overwriting it, because "what did we
 * decide, and did we change our mind" is the question this record exists to
 * answer.
 */

/**
 * `endorse` — the person wanted to be asked; `override` — the agent should
 * have fixed it alone. Both answer a stop, and both mean on this record what
 * they mean on the pull request. `accept` and `reject` judge the finding
 * itself: whether it was a real one. A finding that never stopped anything can
 * only be accepted or rejected, because there was no stop to endorse.
 */
export const VERDICT_DECISIONS = ["endorse", "override", "accept", "reject"] as const;
export const VerdictDecisionSchema = z.enum(VERDICT_DECISIONS);
export type VerdictDecision = (typeof VERDICT_DECISIONS)[number];

/** The decisions that are answers to a stop, and so feed precision of stopping. */
export const STOP_DECISIONS = ["endorse", "override"] as const;
export type StopDecision = (typeof STOP_DECISIONS)[number];

export function isStopDecision(decision: VerdictDecision): decision is StopDecision {
  return decision === "endorse" || decision === "override";
}

/** The review a decision was taken on, in the terms every reader of it has. */
export const VerdictReviewSchema = z.strictObject({
  /** What was given on the command line — a ticket key, a pull request, a review id. */
  reference: z.string().min(1),
  ticket_id: TicketIdSchema,
  /**
   * The admitted ticket's key, and `null` in a build that admits nothing
   * (ADR-0032): the open CLI files work under the id the attempts record
   * carries and has no key to give. The join is `ticket_id`, so nothing here
   * depends on the key being present — it is what a person reads.
   */
  ticket_key: TicketKeySchema.nullable(),
  /** The pull request the ticket names, where it has one; a decision needs none. */
  pull_request_url: z.string().min(1).nullable(),
});
export type VerdictReview = z.infer<typeof VerdictReviewSchema>;

/**
 * Who decided, as the repository itself names them: `user.name` and
 * `user.email` from git config, kept apart rather than run together into one
 * string, so a reader can say which half is which without parsing prose.
 *
 * There is no account behind it and no token: the two config lines are what
 * git already asks every contributor for, and they are read from the checkout
 * the decision is about.
 */
export const DecidedBySchema = z.strictObject({
  name: z.string().min(1),
  email: z.string().min(1),
});
export type DecidedBy = z.infer<typeof DecidedBySchema>;

export const LocalVerdictSchema = z
  .strictObject({
    review: VerdictReviewSchema,
    /** The same key the pull-request checkbox carries for this finding. */
    finding_key: StopFindingKeySchema,
    rule_id: z.string().min(1),
    /**
     * The stop this finding is, if it is one; `null` for a finding that stopped
     * nothing and so can only be accepted or rejected.
     */
    routing: StopRoutingSchema.nullable(),
    decision: VerdictDecisionSchema,
    /** Who took it, as one line: `--author`, else this checkout's git identity. */
    author: z.string().min(1),
    /**
     * The same person, typed — and absent where the record cannot say. Every
     * row written before this field existed carries none and still parses, so
     * a store that predates it keeps being read rather than being migrated;
     * `author` above has always been there and is what every row can be read
     * by. Absent, too, where `--author` named somebody in prose this cannot
     * split into a name and an address: a record that carried a `decided_by`
     * from one source and an `author` from another would contradict itself.
     */
    decided_by: DecidedBySchema.optional(),
    /**
     * Whether the AI stand-in took this decision rather than a person (D-121),
     * which is the same label the pull-request path records on a signed tick.
     * Absent is a person: `perbo verdict` is typed by whoever is at the
     * machine, and only `--stand-in` says otherwise. A row written before this
     * field existed carries none and reads the same way, which is what it
     * meant — the stand-in had no way to say so yet.
     */
    answered_by: StopAnswererSchema.optional(),
    decided_at: z.iso.datetime(),
    note: z.string().min(1).nullable(),
    /**
     * When a later decision on the same key replaced this one. `null` while it
     * stands — a superseded row is kept, never rewritten.
     */
    superseded_at: z.iso.datetime().nullable(),
  })
  // An endorse or an override is an answer to a stop, and a stop has a routing.
  // Enforced here rather than at the command, so that projecting a decision
  // into a stops record never has to invent the field it lacked.
  .refine((row) => !isStopDecision(row.decision) || row.routing !== null, {
    message: "a stop answer (endorse, override) requires the stop's routing",
    path: ["routing"],
  });
export type LocalVerdict = z.infer<typeof LocalVerdictSchema>;

export const LOCAL_VERDICTS_SCHEMA_VERSION = 1;

export const LocalVerdictsSchema = z.strictObject({
  schema_version: z.literal(LOCAL_VERDICTS_SCHEMA_VERSION),
  /** In the order they were taken; a superseded row keeps its place. */
  verdicts: z.array(LocalVerdictSchema),
});
export type LocalVerdicts = z.infer<typeof LocalVerdictsSchema>;

export const EMPTY_LOCAL_VERDICTS: LocalVerdicts = {
  schema_version: LOCAL_VERDICTS_SCHEMA_VERSION,
  verdicts: [],
};

/**
 * One decision per review and finding key, joined by a NUL byte (`\u0000`),
 * which cannot occur in either: a ticket id and a finding key are both hex.
 */
export const verdictKey = (row: Pick<LocalVerdict, "review" | "finding_key">): string =>
  `${row.review.ticket_id}\u0000${row.finding_key}`;

/** The decisions that still stand: at most one per review and finding key. */
export function activeVerdicts(verdicts: readonly LocalVerdict[]): LocalVerdict[] {
  return verdicts.filter((row) => row.superseded_at === null);
}

/** The decision in force for a review and key, or `null` where none was taken. */
export function verdictFor(
  verdicts: readonly LocalVerdict[],
  ticket_id: string,
  finding_key: string,
): LocalVerdict | null {
  return (
    activeVerdicts(verdicts).find(
      (row) => row.review.ticket_id === ticket_id && row.finding_key === finding_key,
    ) ?? null
  );
}

/** A second decision on a key that already has one, without `--replace`. */
export class VerdictConflictError extends Error {
  readonly existing: LocalVerdict;

  constructor(existing: LocalVerdict) {
    super(
      `${existing.finding_key.slice(0, 12)} on ` +
        `${existing.review.ticket_key ?? existing.review.ticket_id} was already ` +
        `decided ${existing.decision} by ${existing.author} at ${existing.decided_at}`,
    );
    this.name = "VerdictConflictError";
    this.existing = existing;
  }
}

/**
 * The next file from the previous one and one decision.
 *
 * A key with no decision in force takes the new row. A key that has one is
 * refused unless `replace` is given, and a replacement **supersedes**: the
 * earlier row is stamped with the moment it stopped standing and stays exactly
 * where it was. Nothing here reads or writes a file; the caller does both, so
 * that a refusal leaves the bytes on disk untouched.
 */
export function recordVerdict(args: {
  previous: LocalVerdicts | null;
  verdict: LocalVerdict;
  replace: boolean;
}): LocalVerdicts {
  const verdict = LocalVerdictSchema.parse(args.verdict);
  const previous = args.previous ?? EMPTY_LOCAL_VERDICTS;
  const key = verdictKey(verdict);
  const standing = activeVerdicts(previous.verdicts).find((row) => verdictKey(row) === key);
  if (standing !== undefined && !args.replace) throw new VerdictConflictError(standing);
  return LocalVerdictsSchema.parse({
    schema_version: LOCAL_VERDICTS_SCHEMA_VERSION,
    verdicts: [
      ...previous.verdicts.map((row) =>
        row.superseded_at === null && verdictKey(row) === key
          ? { ...row, superseded_at: verdict.decided_at }
          : row,
      ),
      verdict,
    ],
  });
}

/**
 * Local stop answers folded into the stops records `perbo sync` wrote, so that
 * one population answers "of the changes with an answer, how many did a person
 * endorse" however the answer was given.
 *
 * Three cases, and all three are ordinary:
 *
 * - a change with a stops record and a local answer to one of its stops — the
 *   answer lands on that stop, matched by the key the checkbox uses;
 * - a change with a stops record and a local answer to something the pull
 *   request never listed — the stop is added, because a decision was taken on
 *   it and a record that drops it under-counts;
 * - a change with no stops record at all — the whole record is built from the
 *   decisions, which is the offline path this command exists for.
 *
 * Where both a tick and a local decision exist for one stop, the later of the
 * two stands: they are the same person answering the same question twice, and
 * the second answer is the one they meant. `accept` and `reject` are not stop
 * answers and never appear here; `perbo inspect` is where they are read.
 */
export function mergeLocalVerdicts(
  files: readonly StopVerdicts[],
  verdicts: readonly LocalVerdict[],
): StopVerdicts[] {
  const byTicket = new Map<string, AnsweredStop[]>();
  for (const row of activeVerdicts(verdicts)) {
    if (!answersAStop(row)) continue;
    byTicket.set(row.review.ticket_id, [...(byTicket.get(row.review.ticket_id) ?? []), row]);
  }

  const merged = files.map((file) => {
    const rows = byTicket.get(file.ticket_id);
    if (rows === undefined || rows.length === 0) return file;
    byTicket.delete(file.ticket_id);
    const decided = new Map(rows.map((row) => [row.finding_key, row]));
    const stops: StopVerdict[] = file.stops.map((stop) => {
      const row = decided.get(stop.finding_key);
      decided.delete(stop.finding_key);
      if (row === undefined) return stop;
      const ticked =
        stop.answer !== null &&
        stop.answered_at !== null &&
        Date.parse(stop.answered_at) > Date.parse(row.decided_at);
      // The answerer travels with the answer: where the decision taken here
      // stands, so does what it says about who took it (D-121).
      return ticked
        ? stop
        : {
            ...stop,
            answer: row.decision,
            answered_at: row.decided_at,
            answered_by: row.answered_by ?? "person",
          };
    });
    const added = [...decided.values()].map(stopFromVerdict);
    const decidedAt = rows.map((row) => row.decided_at);
    return StopVerdictsSchema.parse({
      ...file,
      stops: [...stops, ...added],
      // SCP-189: always true, not computed — this branch only runs where `rows`
      // is non-empty, so `stops.length` (unchanged by the map above) is already
      // positive for a file that had stops, and `added.length` is for one that
      // did not; a decision existing for this ticket is what being shown means.
      shown_to_person: true,
      first_seen_at: earliest([file.first_seen_at, ...decidedAt]),
      observed_at: latest([file.observed_at, ...decidedAt]),
    });
  });

  const built = [...byTicket.values()]
    // A stops record is keyed by an admitted ticket, and a decision taken in a
    // build that admits nothing has no key to give (ADR-0032). Such a decision
    // still stands on its own record; what it cannot do is invent the ticket a
    // stops record is about. Only reached where no stops record exists for the
    // id — the merge above needs no key.
    .filter((rows) => rows[0]!.review.ticket_key !== null)
    .map((rows) => {
      const decidedAt = rows.map((row) => row.decided_at);
      const review = rows[0]!.review;
      return StopVerdictsSchema.parse({
        schema_version: STOP_VERDICTS_SCHEMA_VERSION,
        ticket_id: review.ticket_id,
        ticket_key: review.ticket_key,
        pull_request_url: review.pull_request_url,
        stops: rows.map(stopFromVerdict),
        // Somebody answered a stop on it, which is what being shown one means.
        shown_to_person: true,
        first_seen_at: earliest(decidedAt),
        observed_at: latest(decidedAt),
      });
    })
    .sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));

  return [...merged, ...built];
}

/** A decision that answers a stop, with the routing the schema guarantees it. */
type AnsweredStop = LocalVerdict & { decision: StopDecision; routing: StopVerdict["routing"] };

const answersAStop = (row: LocalVerdict): row is AnsweredStop =>
  isStopDecision(row.decision) && row.routing !== null;

/** One decision as the stop it answers. Both instants are when it was taken. */
function stopFromVerdict(row: AnsweredStop): StopVerdict {
  return {
    finding_key: row.finding_key,
    rule_id: row.rule_id,
    routing: row.routing,
    answer: row.decision,
    answered_at: row.decided_at,
    answered_by: row.answered_by ?? "person",
    first_seen_at: row.decided_at,
  };
}

const byInstant = (instants: readonly string[]): string[] =>
  [...instants].sort((a, b) => Date.parse(a) - Date.parse(b));
const earliest = (instants: readonly string[]): string => byInstant(instants)[0]!;
const latest = (instants: readonly string[]): string => byInstant(instants).at(-1)!;

/**
 * The local verdicts record — `<store>/verdicts.json` — read and written
 * (SCP-181).
 *
 * It sits at the root of the store rather than under `state/`, beside the
 * tickets and the config, because it is not working state: `state/` holds what
 * `perbo sync` can rebuild from a pull request, and nothing can rebuild a
 * decision a person took here. Losing it loses the decision.
 *
 * Reading is split in two on purpose. `perbo verdict` uses the strict reader
 * and refuses to write over a file it cannot parse — a new file started on top
 * of an unreadable one is decisions destroyed silently. `stops` and `inspect`
 * use the lenient one, which names the problem on stderr and reports what it
 * can, because a report that dies on a bad file tells nobody anything.
 */

export const VERDICTS_FILE = "verdicts.json";

export const verdictsPath = (dir: string): string => join(dir, VERDICTS_FILE);

export class VerdictStoreError extends Error {}

/** The record, or the empty one where the file does not exist yet. Throws on a bad file. */
export function readLocalVerdicts(dir: string): LocalVerdicts {
  const path = verdictsPath(dir);
  if (!existsSync(path)) return EMPTY_LOCAL_VERDICTS;
  try {
    return LocalVerdictsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new VerdictStoreError(
      `${path} is not a readable verdicts record: ` +
        `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

/**
 * The same, for a reader: an unreadable file is named on stderr and read as
 * empty. `diagnostics` is nullable for the one caller that builds a report with
 * nowhere to say it — the warning is then left to whoever prints the report.
 */
export function readLocalVerdictsOrWarn(dir: string, diagnostics: Diagnostics | null): LocalVerdicts {
  try {
    return readLocalVerdicts(dir);
  } catch (error) {
    if (!(error instanceof VerdictStoreError)) throw error;
    diagnostics?.stderr(`warning: ${error.message}; local decisions were not counted\n`);
    return EMPTY_LOCAL_VERDICTS;
  }
}

export function writeLocalVerdicts(dir: string, file: LocalVerdicts): void {
  mkdirSync(dir, { recursive: true });
  // Replaced whole: `perbo inspect` reads it while a run is live.
  replaceFile(verdictsPath(dir), `${JSON.stringify(LocalVerdictsSchema.parse(file), null, 2)}\n`);
}

/**
 * Who is taking the decision, when `--author` does not say: this checkout's
 * git identity, which is `user.name` and `user.email` and nothing else.
 *
 * No account and no token. The two config lines are what git already asks
 * every contributor for, they are read from the repository the decision is
 * about, and where the repository names neither the command refuses rather
 * than inventing somebody — the account name of whoever happened to be logged
 * in names a machine, not a person who decided.
 */
export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/** The two config lines to run, named in every refusal. */
export const GIT_IDENTITY_COMMANDS = [
  'git config user.name "Your Name"',
  'git config user.email "you@example.com"',
] as const;

export function readGitIdentity(repositoryRoot: string): GitIdentity {
  const config = (key: string): string | null => {
    try {
      return git.configSync(repositoryRoot, key);
    } catch {
      // No git, no repository, or a read that did not finish: none of them is
      // an error here, and none of them names anybody.
      return null;
    }
  };
  return { name: config("user.name"), email: config("user.email") };
}

/**
 * The identity as one line, in the form git itself writes it — or `null` where
 * the repository names neither half, which is the refusal above. One half on
 * its own still names somebody and is recorded as it stands.
 */
export function authorLine(identity: GitIdentity): string | null {
  const { name, email } = identity;
  if (name !== null && email !== null) return `${name} <${email}>`;
  return name ?? email;
}

/**
 * The typed pair the record carries, where the repository names both halves.
 *
 * `null` where it names one or neither: `decided_by` is a name *and* an
 * address, and half of one padded out with an empty string would be a record
 * claiming something nobody wrote down. The `author` line above still carries
 * whichever half there is.
 */
export function decidedBy(identity: GitIdentity): DecidedBy | null {
  const { name, email } = identity;
  return name !== null && email !== null ? { name, email } : null;
}

/**
 * `--author` read back as the same pair, when it was written in the form this
 * command writes: `Name <email>`. Anything else is prose naming somebody, and
 * prose is left in `author` alone rather than split on a guess.
 */
export function authorIdentity(author: string): DecidedBy | null {
  const match = /^\s*(\S.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(author);
  return match === null ? null : { name: match[1]!, email: match[2]! };
}
