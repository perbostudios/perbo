import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { StoredAdmissionSchema } from "./admission.js";
import {
  ApproachRecordSchema,
  AuthoredAttemptSchema,
  D073_CHANGES_REQUESTED,
  PlanContractSchema,
  StoredTicketSchema,
  TICKET_SCHEMA_VERSION,
  TicketKeySchema,
  approachPath as approachSegments,
  attemptsPath,
  contractPath as contractSegments,
  draftPath as draftSegments,
  isAbsolutePath,
  mergedAt,
  ticketFilePath as ticketSegments,
  ticketsDir,
  type ApproachRecord,
  type PlanContract,
  type StoredTicket,
  type Ticket,
  type TicketState,
} from "@perbo/contracts";
import { ContractDraftSchema, DraftModelRecordSchema } from "@perbo/planning";
import { AttemptsRecordError, lastAttemptBranch, readAttemptsRecord } from "@perbo/runner";
import { branchName, recordedBranch, replaceFile } from "@perbo/workspace";
import { listLocalRuns, type LocalRunRecord } from "../commands/run/local.js";
import { StoreError, repositoryRootOf, storeDir, storedRepositoryRoot } from "./index.js";

/**
 * The ticket store (roadmap item 11).
 *
 * A directory of JSON files under the repository, not a database: execution is
 * local ([ADR-0004](../../../../docs/adr/0004-local-first-runner.md)), and this is
 * the state that execution produces.
 *
 * Three files per ticket, and a fourth where the plan has a graph:
 *
 * - `PRB-118.json` is the ticket: intent, state, history. It changes constantly.
 * - `PRB-118.contract.json` is the plan contract. After approval it is
 *   **immutable** ([ADR-0016](../../../../docs/adr/0016-minimal-machine-maintained-planning.md)),
 *   and keeping it in its own file is what makes "the contract did not change
 *   during execution" checkable with `git diff` rather than believed.
 * - `PRB-118.draft.json` is the contract as it was shown to the person — a
 *   model's draft, or the typed one — with the model's provenance where a model
 *   drafted it, and the record of every `perbo edit` applied to it. Neither
 *   execution nor review reads what is *in* it. It exists so that
 *   `admission.edit_count` is a computed number rather than a recollection, and
 *   so that the contract has a counter-seal: `admit` and `perbo edit` write
 *   both files together and nothing else writes either, so a difference between
 *   them is somebody's text editor. `approve` and `perbo run --ticket` refuse a
 *   ticket whose pair disagrees, is missing or does not parse — for a ticket
 *   whose `admission.counter_sealed_at` says it was written with one.
 * - `PRB-118.approach.json` is the approach: the suggested order between the
 *   plan's nodes and the spec's No-Gos ([D-100](../../../../docs/11-open-decisions.md)).
 *   It is there only where the plan has a graph or the spec states a No-Go, it
 *   is not counter-sealed, and `perbo edit` rewrites it after approval as well
 *   as before — it is the half of the plan the contract deliberately does not
 *   freeze. Review never reads it.
 * - `PRB-118.drift.json` is the plan read against its spec: where the two no
 *   longer promise the same thing, kept against the spec's bytes and the
 *   plan's promise texts so it holds while neither moves. Read and written
 *   only through `@perbo/planning`'s `drift-record.ts`: written by `admit`, by
 *   the interview and by `perbo drift`; read by `perbo drift` and by the
 *   interview's `carryDrift` as a chat turn brings a clean verdict forward; and
 *   read and written by the desktop host as a rename carries it to the
 *   retitled spec. It is
 *   advice on the way to the contract and nothing gates on it
 *   ([D-128](../../../../docs/11-open-decisions.md)).
 */

/** Lives beside the tickets and is not one; `listTickets` skips it by name. */
const SEQUENCE_FILE = "sequence.json";

/**
 * Where the store is and what it declares are open (`store.js`); the tickets
 * inside it are not. Re-exported under the names this module has always used so
 * that a caller reading the ticket store keeps one import.
 */
export {
  DEFAULT_REPOSITORY_ROOT,
  headCommit,
  repositoryId,
  repositoryRootOf,
  storeDir,
  storedRepositoryRoot,
  trackedFiles,
} from "./index.js";
export { JUDGING_CONFIG_KEYS, judgingPaths, readJudgingPaths, standingProhibited } from "./index.js";
export type {
  CheckDefinitionSource,
  JudgingPath,
  JudgingRule,
  JudgingSource,
} from "./index.js";

/** The name this store's callers know {@link StoreError} by. One class, two names. */
const TicketStoreError = StoreError;
export { TicketStoreError };

/** The high-water mark per key prefix. Values only ever increase. */
const SequenceSchema = z.record(z.string().min(1), z.number().int().min(0));

const ticketPath = (dir: string, key: string) => join(dir, ...ticketSegments(key));
const contractPath = (dir: string, key: string) => join(dir, ...contractSegments(key));
const draftPath = (dir: string, key: string) => join(dir, ...draftSegments(key));
const approachPath = (dir: string, key: string) => join(dir, ...approachSegments(key));

/** Where a ticket's contract lives, for `perbo edit` to open it. */
export const contractPathFor = contractPath;
/** Where a ticket's approach lives, for a caller that reports the file. */
export const approachPathFor = approachPath;

/** A ticket file by name: not the contract, the draft, the approach or the sequence. */
const isTicketFile = (name: string) =>
  name.endsWith(".json") &&
  !name.endsWith(".contract.json") &&
  !name.endsWith(".draft.json") &&
  !name.endsWith(".approach.json") &&
  !name.endsWith(".drift.json") &&
  name !== SEQUENCE_FILE;

/**
 * A stored ticket's JSON, with the shapes a previous version wrote that the
 * schema no longer admits read as what they meant.
 *
 * Two of them, both from before the record was expected to travel:
 *
 * `--from-file` recorded `kind: "none"` with the file's absolute path in the
 * reference. `none` now means "nothing to point at" and requires a null one, so
 * that record fails validation — and every command that touches the store
 * parses through here, so an unmigrated store would take `list`, `inspect`,
 * `run` and `admit` down with it. A `none` carrying a reference is that
 * admission and nothing else, so it reads back as the `file` source it always
 * was.
 *
 * `repository_root` held the admitting machine's absolute path. Every ticket in
 * this repository's own store carries one, and each names a directory that
 * exists on exactly one laptop; read anywhere else it sent `run` and `sync` at
 * somebody else's checkout or at nothing. It is dropped rather than translated,
 * because there is no translation: the field is not a fact about the record, and
 * a store that has lost it reads back as the store it was found in, which is the
 * only checkout the ticket could have meant. For a store that was moved out of
 * its repository that reading is a choice rather than the only answer, and
 * {@link warnDroppedRoot} says which way it went instead of leaving it silent.
 *
 * Nothing is rewritten on disk here; the next write of the ticket carries the
 * corrected shape.
 */
function storedTicketJson(dir: string, path: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") return raw;
  let record = raw as Record<string, unknown>;
  const root = record["repository_root"];
  if (typeof root === "string" && isAbsolutePath(root)) {
    warnDroppedRoot(dir, path, root);
    record = { ...record };
    delete record["repository_root"];
  }
  const source = record["source"];
  if (source === null || typeof source !== "object") return record;
  const stored = source as Record<string, unknown>;
  const reference = stored["reference"];
  if (stored["kind"] !== "none" || reference === null || reference === undefined) return record;
  return { ...record, source: { ...stored, kind: "file" } };
}

/**
 * Say on stderr that a ticket's absolute `repository_root` was dropped, when
 * dropping it is a *choice between two real directories* rather than the only
 * reading left.
 *
 * For the ordinary `<repo>/.perbo` store the choice does not arise, whatever
 * the record says: the ticket file is *inside* a checkout, so that checkout is
 * the one it is a record of. The recorded path being a directory that also
 * exists here changes nothing — it is another worktree of the same repository
 * or another clone of it — and warning about it would put a line on the
 * terminal for every legacy ticket in every store on the admitting machine.
 *
 * It does arise for a store pointed somewhere else with `--store`. There the
 * store's parent is not a checkout of anything in particular, and if the
 * recorded path exists on this machine then two directories answer to the
 * record and only one of them is used. `run` provisions worktrees under the one
 * that is used and `sync` polls the pull request from it, so which one it is
 * belongs on the terminal rather than in the resolution rules alone.
 */
function warnDroppedRoot(dir: string, path: string, dropped: string): void {
  const resolved = repositoryRootOf(dir);
  const relocated = resolve(dir) !== storeDir(resolved);
  if (!relocated || resolve(dropped) === resolved || !existsSync(dropped)) return;
  process.stderr.write(
    `warning: ${path} records repository_root ${dropped}, an absolute path from the machine ` +
      `that admitted it. This store is not inside a repository, so the ticket is read as its ` +
      `parent ${resolved}, and that is the checkout \`run\` and \`sync\` will act on — but ` +
      `${dropped} is on this machine too. If the ticket belongs to that checkout, read it from ` +
      `a store inside it.\n`,
  );
}

/**
 * A record as it was stored, as the rest of the process uses it: the repository
 * root it carries relative to `dir` — or does not carry at all — resolved
 * against the store it was actually read from.
 *
 * One function for both readers, because the resolution is the whole of what
 * separates the two shapes and neither reader should be able to forget it.
 */
function resolvedAgainst<T extends { repository_root?: string | undefined }>(
  dir: string,
  stored: T,
): Omit<T, "repository_root"> & { repository_root: string } {
  return { ...stored, repository_root: repositoryRootOf(dir, stored.repository_root) };
}

export function listTickets(dir: string): Ticket[] {
  const inside = join(dir, ...ticketsDir());
  if (!existsSync(inside)) return [];
  const unreadable: string[] = [];
  const tickets = readdirSync(inside)
    .filter(isTicketFile)
    .flatMap((name) => {
      // One unreadable file used to take the whole store with it: an editor
      // backup, a half-written ticket from an interrupted run, or one written
      // by a later `schema_version` made `list` throw and — because `nextKey`
      // reads the same directory — made it impossible to admit *new,
      // unrelated* work. A bad file is named and stepped over.
      try {
        return [
          resolvedAgainst(dir, StoredTicketSchema.parse(storedTicketJson(dir, join(inside, name)))),
        ];
      } catch {
        unreadable.push(name);
        return [];
      }
    })
    .sort((a, b) => a.admitted_at.localeCompare(b.admitted_at));
  if (unreadable.length > 0) {
    // Named on stderr rather than silently skipped: a store that shrank must
    // never look like a small one.
    process.stderr.write(
      `warning: ${unreadable.length} file(s) in ${inside} are not readable tickets and were ` +
        `skipped: ${unreadable.join(", ")}\n`,
    );
  }
  return tickets;
}

function ticketFile(dir: string, key: string): unknown {
  const path = ticketPath(dir, key);
  if (!existsSync(path)) {
    const known = listTickets(dir).map((ticket) => ticket.key);
    throw new TicketStoreError(
      `no ticket ${key} in ${dir}` + (known.length > 0 ? ` (admitted: ${known.join(", ")})` : ""),
    );
  }
  return storedTicketJson(dir, path);
}

export function readTicket(dir: string, key: string): Ticket {
  return resolvedAgainst(dir, StoredTicketSchema.parse(ticketFile(dir, key)));
}

/** A ticket as a reader shows it: strict everywhere except that record. */
const DisplayTicketSchema = StoredTicketSchema.omit({ admission: true }).extend({
  admission: StoredAdmissionSchema,
});
export type DisplayTicket = Omit<z.infer<typeof DisplayTicketSchema>, "repository_root"> & {
  /** Resolved, like {@link Ticket}'s: what is on disk is relative or absent. */
  repository_root: string;
};

/**
 * Read a ticket for display. Only `inspect` uses this: everything that acts on
 * a ticket reads it through `readTicket`, where an admission record the current
 * schema rejects is a fault rather than something to render.
 */
export function readTicketForDisplay(dir: string, key: string): DisplayTicket {
  return resolvedAgainst(dir, DisplayTicketSchema.parse(ticketFile(dir, key)));
}

export function readContract(dir: string, key: string): PlanContract {
  return PlanContractSchema.parse(JSON.parse(readFileSync(contractPath(dir, key), "utf8")));
}

/**
 * A ticket and the contract beside it must be the same piece of work.
 *
 * Cheap, and it catches the one corruption this store can actually suffer: two
 * files edited independently. Execution binds to the contract and review judges
 * against it, so a ticket pointing at somebody else's plan would run the wrong
 * work under the right name.
 */
export function assertContractMatches(ticket: Ticket, contract: PlanContract): void {
  if (contract.plan_id !== ticket.plan_id || contract.ticket_id !== ticket.ticket_id) {
    throw new TicketStoreError(
      `${ticket.key} names plan ${ticket.plan_id} for ticket ${ticket.ticket_id}, and the ` +
        `contract beside it is ${contract.plan_id} for ${contract.ticket_id}. One of the two ` +
        "files was edited on its own; neither can be trusted until that is resolved",
    );
  }
}

/**
 * Write the ticket, with its repository root put back the way a file has to
 * carry it: relative to this store, so the next clone to read it resolves the
 * checkout it is itself in.
 *
 * The relativisation is here rather than at the call sites because this is the
 * only place a ticket becomes a file. A caller holds a resolved root — it has to,
 * it hands the thing to git — and there is nowhere for it to remember that the
 * on-disk shape is a different one.
 *
 * What is about to be written is parsed by the same schema that reads it back,
 * and a record that does not pass is a `TicketStoreError` before the file is
 * touched. The type says the root is relative; only the parse *checks* it, and
 * there is one arrangement where the relativisation cannot deliver that — a
 * store on a different Windows drive from its repository, where `relative` has
 * no path to return and returns an absolute one. Written, that record would
 * name the admitting machine again and read back as this store's parent on the
 * next machine. The store refusing to write it is how that stays a failure
 * somebody sees rather than a root that quietly moves.
 */
export function writeTicket(dir: string, ticket: Ticket): string {
  const path = ticketPath(dir, ticket.key);
  const stored: StoredTicket = {
    ...ticket,
    repository_root: storedRepositoryRoot(dir, ticket.repository_root),
  };
  // The record itself is written, not the parse's output: this is a check on
  // the way out, and a schema's idea of key order is not a reason for the next
  // write of every ticket in the store to rewrite every line of it.
  const parsed = StoredTicketSchema.safeParse(stored);
  if (!parsed.success) {
    throw new TicketStoreError(
      `${ticket.key} cannot be written to ${path}: ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(ticket)"}: ${issue.message}`)
          .join("; "),
    );
  }
  mkdirSync(join(dir, ...ticketsDir()), { recursive: true });
  replaceFile(path, `${JSON.stringify(stored, null, 2)}\n`);
  return path;
}

/**
 * Write the contract. Refuses to overwrite an approved one: after approval the
 * contract is immutable, and a store that silently accepted a rewrite would
 * make execution unbound by the thing review judges it against.
 */
export function writeContract(dir: string, ticket: Ticket, contract: PlanContract): string {
  mkdirSync(join(dir, ...ticketsDir()), { recursive: true });
  const path = contractPath(dir, ticket.key);
  if (ticket.approved_at !== null && existsSync(path)) {
    const existing = readContract(dir, ticket.key);
    if (existing.version === contract.version) {
      throw new TicketStoreError(
        `contract ${contract.plan_id} v${contract.version} for ${ticket.key} was approved at ` +
          `${ticket.approved_at} and is immutable; a change to it is a new version`,
      );
    }
  }
  replaceFile(path, `${JSON.stringify(contract, null, 2)}\n`);
  return path;
}

/**
 * The approach beside the ticket: `<KEY>.approach.json`, a fourth file for the
 * half of a graphed plan that is **not** contract (D-100, ADR-0016).
 *
 * Written by admission where the plan has nodes or the spec states No-Gos, and
 * rewritten by `perbo edit` before and after approval — the contract is
 * immutable from approval and this is not the contract. Nothing in the review
 * path reads it, which is what keeps a No-Go out of a verdict.
 */
export function writeApproachRecord(dir: string, key: string, approach: ApproachRecord): string {
  mkdirSync(join(dir, ...ticketsDir()), { recursive: true });
  const path = approachPath(dir, key);
  replaceFile(path, `${JSON.stringify(ApproachRecordSchema.parse(approach), null, 2)}\n`);
  return path;
}

/** Remove the approach record, where a plan no longer has a graph or No-Gos to keep in it. */
export function deleteApproachRecord(dir: string, key: string): void {
  rmSync(approachPath(dir, key), { force: true });
}

/**
 * The approach beside a ticket, or null where there is none — a flat plan
 * admitted from an issue has no order to record and no No-Gos to carry.
 *
 * A file that is there and does not parse is a `TicketStoreError` naming it,
 * as an unreadable draft snapshot is: it is a record somebody edited by hand.
 * Given the contract, a record naming another ticket or plan is refused the
 * same way rather than read as this plan's order: a copied or stale file
 * carries someone else's edges and No-Gos, and nothing in an edge says whose
 * it is.
 */
export function readApproachRecord(
  dir: string,
  key: string,
  contract?: Pick<PlanContract, "ticket_id" | "plan_id">,
): ApproachRecord | null {
  const path = approachPath(dir, key);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TicketStoreError(
      `${key}.approach.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = ApproachRecordSchema.safeParse(raw);
  if (parsed.success) {
    if (contract && (parsed.data.ticket_id !== contract.ticket_id || parsed.data.plan_id !== contract.plan_id)) {
      throw new TicketStoreError(
        `${key}.approach.json names ticket ${parsed.data.ticket_id} and plan ${parsed.data.plan_id}, ` +
          `not this ticket's ${contract.ticket_id} and ${contract.plan_id}; it is another plan's approach. ` +
          "Restore the file from version control, or remove it and rebuild the order with --graph-edit",
      );
    }
    return parsed.data;
  }
  throw new TicketStoreError(
    `${key}.approach.json is not an approach record: ` +
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(approach)"}: ${issue.message}`)
        .join("; "),
  );
}

export const DRAFT_SNAPSHOT_VERSION = 1;

/**
 * Who made an edit. `you` is the person at the command line, and is what
 * `admission.edit_count` counts; `interview` is their own agent session asking
 * for one on their behalf, which does not raise that count (D-100).
 */
export const EDIT_AUTHORS = ["you", "interview"] as const;
export type EditAuthor = (typeof EDIT_AUTHORS)[number];

/**
 * One `perbo edit`, in the words `contractEditCount` counted it in, with what
 * a graph edit needs to be undone: the entity keys it touched and each key's
 * value either side.
 *
 * Every field past `changes` is defaulted, so a record written before graph
 * edits existed reads back as a flag edit by the person, which is what it was.
 * The edit's **number** is its position in the list, one upward — there is no
 * stored sequence, because a list already has one and two would drift.
 */
export const AppliedEditSchema = z.strictObject({
  at: z.iso.datetime(),
  changes: z.array(z.string().min(1)),
  author: z.enum(EDIT_AUTHORS).default("you"),
  /** One line: what the edit did. Null for a record written before summaries. */
  summary: z.string().min(1).nullable().default(null),
  /** `node:<id>`, `criterion:<id>`, `edge:<from>-><to>`. */
  keys: z.array(z.string().min(1)).default([]),
  before: z.record(z.string().min(1), z.unknown()).default({}),
  after: z.record(z.string().min(1), z.unknown()).default({}),
  /** True once `--undo` reverted it. It stays in the log either way (D-100). */
  undone: z.boolean().default(false),
  /**
   * True once the plan was re-drafted from its spec over the top of it
   * (`admit --from-spec --start-over`, D-103). The edit stays in the log, and
   * is no longer in force: it does not count towards `edit_count`, and it
   * cannot be undone, because the contract it changed is gone.
   */
  replaced: z.boolean().default(false),
  /** The edit this one undid, by its number. Null for an edit of its own. */
  undoes: z.number().int().positive().nullable().default(null),
});
export type AppliedEdit = z.infer<typeof AppliedEditSchema>;

/**
 * The contract as it was agreed, beside the record of how it got there.
 *
 * `contract` is the contract as `admit` rendered it and as every `perbo edit`
 * since has left it — the counter-seal `approve` compares `<KEY>.contract.json`
 * against. The two files are written together by those two commands and by
 * nothing else, so any difference between them is a hand edit, and `approve`
 * refuses it rather than executing a contract nobody was shown.
 *
 * `edits` is what each of those edits changed, which is where
 * `admission.edit_count` now comes from: with the two contracts held in step,
 * the difference between them is no longer a record of anything a person did.
 * `draft` is null for a typed admission, and for a ticket whose snapshot was
 * first written by an edit.
 */
export const DraftSnapshotSchema = z.strictObject({
  schema_version: z.literal(DRAFT_SNAPSHOT_VERSION),
  key: TicketKeySchema,
  /** When the contract was first shown. Equal to the ticket's `admitted_at`. */
  rendered_at: z.iso.datetime(),
  /**
   * The ticket's own list, not a shorter one: `admit` writes four of the five,
   * and the fifth reaches here when the first edit of an imported ticket seals
   * a snapshot beside it.
   */
  criteria_source: z.enum(["typed", "imported", "file", "drafted", "spec"]),
  contract: PlanContractSchema,
  /**
   * Every edit applied since, in order. Defaulted so a snapshot written before
   * edits were recorded here reads back as an unedited one rather than failing
   * to parse — which for that ticket is what it is: the contract beside it is
   * the one it was rendered with, or `approve` will say so.
   */
  edits: z.array(AppliedEditSchema).default([]),
  draft: z
    .strictObject({
      issue: z.strictObject({
        /** `owner/repo#412`, or `file:<name>` for a pasted one. */
        reference: z.string().min(1),
        /** Null for a source that has none, which a pasted file never does. */
        url: z.url().nullable(),
        /**
         * The file it was read from, resolved against the working directory
         * the person typed it in, so it still names that file when the
         * snapshot is read from somewhere else. Null for a fetch.
         */
        path: z.string().min(1).nullable().default(null),
        title: z.string().min(1),
      }),
      /** Exactly what the model returned, before any override or derivation. */
      proposed: ContractDraftSchema,
      model: DraftModelRecordSchema,
      unknown_roots: z.array(z.string().min(1)),
      /**
       * What the issue text tried on the drafter, found by reading the body.
       * Defaulted rather than required so a snapshot written before this was
       * recorded still reads back as empty: nothing scanned that draft, which
       * is not the same as having found nothing, and the alternative is a
       * stored draft that no longer parses.
       */
      issue_authored_attempts: z.array(AuthoredAttemptSchema).default([]),
      /**
       * How many attempts the text held, which is the listing's length unless
       * the listing was capped. Null for a snapshot written before the count
       * was kept — not zero, which would claim a body was read and found
       * clean; a reader with null falls back to the length it can see.
       */
      issue_authored_attempts_found: z.number().int().min(0).nullable().default(null),
      /** Every file the drafter opened or was refused, in order. Empty before reads existed, and without a reader. */
      files_read: z
        .array(z.strictObject({ path: z.string(), bytes: z.number().int().min(0), refused: z.string().nullable() }))
        .default([]),
    })
    .nullable(),
});
export type DraftSnapshot = z.infer<typeof DraftSnapshotSchema>;

export function writeDraftSnapshot(dir: string, snapshot: DraftSnapshot): string {
  mkdirSync(join(dir, ...ticketsDir()), { recursive: true });
  const path = draftPath(dir, snapshot.key);
  replaceFile(path, `${JSON.stringify(DraftSnapshotSchema.parse(snapshot), null, 2)}\n`);
  return path;
}

/**
 * What is at `<KEY>.draft.json`: nothing, a snapshot, or bytes that are not one.
 *
 * Three cases rather than a snapshot-or-throw, because the callers do different
 * things with the third. A file that does not parse is the same hand edit the
 * counter-seal exists to catch — often the same one, a text editor that left the
 * JSON broken as well as changed — so `approve` has to be able to say that in
 * the words it says a mismatch in, and `perbo edit`, which rewrites the file,
 * has to be able to proceed past it. Neither can do that with a `SyntaxError`
 * from `JSON.parse`.
 */
export type DraftSnapshotFile =
  | { kind: "absent" }
  | { kind: "snapshot"; snapshot: DraftSnapshot }
  /** `reason` completes "…draft.json cannot be read: …", for a person. */
  | { kind: "unreadable"; reason: string };

export function readDraftSnapshotFile(dir: string, key: string): DraftSnapshotFile {
  const path = draftPath(dir, key);
  if (!existsSync(path)) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `it is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const parsed = DraftSnapshotSchema.safeParse(raw);
  if (parsed.success) return { kind: "snapshot", snapshot: parsed.data };
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(snapshot)"}: ${issue.message}`,
  );
  return { kind: "unreadable", reason: `it is not a draft snapshot (${issues.join("; ")})` };
}

/**
 * The snapshot beside a ticket. Null for a ticket admitted before snapshots
 * were kept, and a `TicketStoreError` naming the file for one that is there and
 * does not parse — a raw parse error names neither the ticket nor the file.
 */
export function readDraftSnapshot(dir: string, key: string): DraftSnapshot | null {
  const file = readDraftSnapshotFile(dir, key);
  if (file.kind === "absent") return null;
  if (file.kind === "unreadable") {
    throw new TicketStoreError(`${key}.draft.json cannot be read: ${file.reason}`);
  }
  return file.snapshot;
}

/**
 * The next key in the sequence.
 *
 * A high-water mark on disk, not the maximum of what is currently there. Those
 * differ exactly when a ticket is deleted, and the difference matters: a ticket
 * key is an identifier somebody has already written into a branch name, a
 * commit message or a chat, and handing it to a second piece of work makes two
 * unrelated things share a name. Scanning alone would recycle the highest key
 * the moment it was removed.
 *
 * The mark is the larger of the recorded one and what is actually present, so a
 * store whose sequence file is missing or has been rolled back still cannot
 * collide with a ticket it can see.
 */
export function nextKey(dir: string, prefix: string): string {
  // Filenames, not parsed tickets: a file this cannot read still holds its key,
  // and handing that key to new work would make two things share a name.
  const inside = join(dir, ...ticketsDir());
  const present = (existsSync(inside) ? readdirSync(inside) : [])
    .filter(isTicketFile)
    .map((name) => name.slice(0, -".json".length))
    .filter((key) => key.startsWith(`${prefix}-`))
    .map((key) => Number(key.slice(prefix.length + 1)))
    .filter((value) => Number.isInteger(value));
  const recorded = readSequence(dir)[prefix] ?? 0;
  return `${prefix}-${Math.max(recorded, 0, ...present) + 1}`;
}

const sequencePath = (dir: string) => join(dir, ...ticketsDir(), SEQUENCE_FILE);

function readSequence(dir: string): Record<string, number> {
  const path = sequencePath(dir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return SequenceSchema.parse(parsed);
  } catch {
    // A corrupt sequence file must not stop work, and must not silently allow a
    // collision either: returning nothing falls back to the scan, which is a
    // weaker guarantee but never hands out a key that is currently in use.
    return {};
  }
}

/** Record that `key` was issued, so deleting it does not free the number. */
export function recordIssued(dir: string, key: string): void {
  const [prefix, number] = [key.slice(0, key.lastIndexOf("-")), Number(key.slice(key.lastIndexOf("-") + 1))];
  const sequence = readSequence(dir);
  if ((sequence[prefix] ?? 0) >= number) return;
  mkdirSync(join(dir, ...ticketsDir()), { recursive: true });
  replaceFile(
    sequencePath(dir),
    `${JSON.stringify({ ...sequence, [prefix]: number }, null, 2)}\n`,
  );
}

/**
 * What the plan was captured against, hashed.
 *
 * Not a placeholder: `base_commit` fixes the tree and the scope fixes which
 * part of it the plan claims to be about, so those two together are the context
 * a P1 contract was drafted against. Plan invalidation compares against this.
 */
export function contextManifestHash(input: {
  base_commit: string;
  repository_id: string;
  paths_allowed: readonly string[];
  paths_prohibited: readonly string[];
  generated_paths: readonly string[];
}): string {
  const canonical = JSON.stringify({
    base_commit: input.base_commit,
    repository_id: input.repository_id,
    paths_allowed: [...input.paths_allowed].sort(),
    paths_prohibited: [...input.paths_prohibited].sort(),
    generated_paths: [...input.generated_paths].sort(),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** A stable opaque id from the key and the moment of admission. */
export function idsFor(key: string, at: Date): { ticket_id: string; plan_id: string } {
  const digest = createHash("sha256").update(`${key}|${at.toISOString()}`).digest("hex");
  return { ticket_id: `ticket_${digest.slice(0, 16)}`, plan_id: `plan_${digest.slice(16, 32)}` };
}

export const SCHEMA_VERSION = TICKET_SCHEMA_VERSION;

/* ------------------------------------------------------------------ *
 * The store's other half: the runs nobody admitted a ticket for.
 * ------------------------------------------------------------------ */

/**
 * One change this store holds, whether a ticket named it or a local run did
 * (SCP-284).
 *
 * `perbo run --outcome "…"` is the loop with nothing admitted behind it, and
 * on a repository nobody admitted anything on it is the *only* way work runs.
 * Everything downstream of the pull request — `sync`, `escapes`, `stops` —
 * was written against the ticket file, so on such a repository each of them
 * read an empty store and reported that nothing had ever happened, over a
 * store holding a run record per change and a pull request per run.
 *
 * This is the one place the two records are read as the same thing, and it is
 * in this module because both of them are this store: `<store>/tickets` holds
 * one kind and `<store>/runs` the other. A ticket carries its delivery on the
 * ticket file; a local run carries it on the run record `perbo run` wrote
 * about itself, under the same fields. Every reader takes a
 * {@link SyncedChange} and asks it the questions it always asked — which
 * state, what does its delivery say, when did it merge — so a local run counts
 * in D-060's, D-076's and SCP-145's numbers on exactly the terms an admitted
 * ticket does, rather than through a second implementation of each.
 *
 * The `kind` is kept because two things still differ and neither should be
 * guessed: what a person types to read the change back (`PRB-1`, or the run
 * id), and where its cost is rolled from.
 */
export type SyncedChange = {
  /** What a person types to name it: the ticket key, or the run id. */
  key: string;
  /** What every attempt, bundle and state file in this store is keyed by. */
  ticket_id: string;
  /** The checkout the change was executed in, resolved. */
  repository_root: string;
  /** The branch its pull request is on, null where nothing has one yet. */
  branch: string | null;
  state: TicketState;
  delivery: Ticket["delivery"];
  /** When this change's own record says it merged; null while it has not. */
  merged_at: string | null;
} & ({ kind: "ticket"; ticket: Ticket } | { kind: "local_run"; run: LocalRunRecord });

/**
 * The branch the latest attempt on this store's attempts record for
 * `ticketId` worked on, or null where the record names none.
 *
 * Read the way the loop reads it before it provisions, so what a reader finds
 * is the branch the next run keeps. An unreadable record names none and the
 * branch is derived instead: the store's listings name every change's branch
 * through this, and one bad record must not take a listing with it.
 */
export function latestAttemptBranch(dir: string, ticketId: string): string | null {
  try {
    return lastAttemptBranch(readAttemptsRecord(join(dir, ...attemptsPath(ticketId))));
  } catch (error) {
    if (error instanceof AttemptsRecordError) return null;
    throw error;
  }
}

/**
 * The branch a local run published on: the one its attempts record names, or
 * the one the runner would derive.
 *
 * A branch on record is kept (D-098), so a run that published on `ayo/` is
 * looked up there. Where none is, `branchName` is the runner's own naming
 * function and the run record holds all of its inputs — the label the run is
 * keyed by, the id the plan is keyed by and the outcome the contract states —
 * so the same inputs name the same branch again here. Re-deriving it is what
 * keeps a run recoverable from its record alone; reimplementing the slug rule
 * would send `sync` looking for a pull request under a name the runner never
 * used.
 */
export function localRunBranch(dir: string, run: LocalRunRecord): string {
  return (
    recordedBranch({ attempt: latestAttemptBranch(dir, run.run_id) }, run.run_id) ??
    branchName({ ticket_key: run.label, ticket_id: run.run_id, outcome: run.contract.outcome })
  );
}

/**
 * Where a local run stands, in the lifecycle vocabulary every reader of a
 * change already speaks.
 *
 * A run has no lifecycle of its own — nothing admitted it, so there is no
 * state machine walking it anywhere — and what it does have is the pull
 * request it opened and whatever `sync` last read off it. That is enough to
 * answer the question each reader is actually asking, and each answer is a
 * fact on the record rather than an inference: `merged` and `closed` are what
 * `gh` said, `changes_requested` is a close carrying a D-073 CHANGES
 * REQUESTED verdict (D-083, the same reading `sync` gives a ticket), and
 * `pr_open` is a pull request the run itself published and nothing has
 * contradicted.
 *
 * A run with no pull request is `failed` where its own record says it was
 * refused, and `executing` otherwise — a run that has not published is either
 * still going or died before it did, and neither is something to report as a
 * change that reached a person.
 */
export function localRunState(run: LocalRunRecord): TicketState {
  const pull = run.pull_request;
  if (pull === null) return run.refusal === null ? "executing" : "failed";
  switch (pull.state) {
    case "merged":
      return "merged";
    case "closed":
      return pull.review_verdicts.some((one) => one.verdict === D073_CHANGES_REQUESTED)
        ? "changes_requested"
        : "closed";
    // `open`, and `null` for a pull request nothing has read back: the run
    // opened it first-hand, which is the strongest evidence there is that it
    // is there.
    default:
      return "pr_open";
  }
}

/**
 * A local run's delivery, in the shape a ticket carries one.
 *
 * `opened_by` and `arm` are `loop` on the same first-hand grounds
 * `recordDelivery` writes them on a ticket: the run being described opened
 * this pull request itself. `merged_by` is null — `sync --merge` is a
 * ticket's command, so no local run's merge is the loop's own — and
 * `incomplete_review` is null because nothing on the run record says
 * otherwise.
 */
export function localRunDelivery(dir: string, run: LocalRunRecord): Ticket["delivery"] {
  const pull = run.pull_request;
  return {
    branch: localRunBranch(dir, run),
    pull_request_url: pull?.url ?? null,
    pull_request_number: pull?.number ?? null,
    state: pull === null ? "none" : (pull.state ?? "open"),
    // The read that dates these values, or the publish that did before one
    // happened — never `updated_at`, which no run record has.
    observed_at: pull?.observed_at ?? pull?.opened_at ?? null,
    opened_by: pull === null ? null : "loop",
    mergeable: pull?.mergeable ?? null,
    commits_outside_loop: pull?.commits_outside_loop ?? null,
    github_credential: pull?.github_credential ?? null,
    arm: "loop",
    merged_by: null,
    incomplete_review: null,
    checks: pull?.checks ?? [],
    checks_state: pull?.checks_state ?? null,
  };
}

export function ticketChange(ticket: Ticket): SyncedChange {
  return {
    kind: "ticket",
    ticket,
    key: ticket.key,
    ticket_id: ticket.ticket_id,
    repository_root: ticket.repository_root,
    branch: ticket.delivery.branch,
    state: ticket.state,
    delivery: ticket.delivery,
    merged_at: mergedAt(ticket),
  };
}

/**
 * A local run as a change. `dir` is the store it was read from, which is what
 * says where its repository is — a run record keeps no root of its own, and
 * the store it sits in is inside the checkout it ran against.
 *
 * `merged_at` is when the sync that saw the merge read it, which is the only
 * date the run's own record carries. For a ticket it is when the ticket walked
 * to `merged`, which is the same instant for the same reason: both are written
 * by the sync that read `gh`.
 */
export function localRunChange(dir: string, run: LocalRunRecord): SyncedChange {
  const delivery = localRunDelivery(dir, run);
  const state = localRunState(run);
  return {
    kind: "local_run",
    run,
    key: run.run_id,
    ticket_id: run.run_id,
    repository_root: repositoryRootOf(dir),
    branch: delivery.branch,
    state,
    delivery,
    merged_at: state === "merged" ? delivery.observed_at : null,
  };
}

/**
 * Every change this store holds: the admitted tickets, then the local runs.
 *
 * Both, always — a store can hold each kind, and a repository that admitted
 * its tenth ticket does not stop having run its first nine without one.
 */
export function listChanges(dir: string): SyncedChange[] {
  return [
    ...listTickets(dir).map(ticketChange),
    ...listLocalRuns(dir).map((run) => localRunChange(dir, run)),
  ];
}

