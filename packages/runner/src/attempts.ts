import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AttemptWaitSchema,
  VerifiedCommitSchema,
  attemptId,
  type AttemptWait,
  type ExecutionAttempt,
  type VerifiedCommit,
} from "@perbo/contracts";
import { sameCommit } from "./resume.js";

/**
 * The ticket's attempts record: one file per ticket, **appended to** by every
 * run of it.
 *
 * The file used to be replaced wholesale when a run ended (SCP-155), so a
 * second run of the same contract erased the first — including the run a
 * ceiling cut short, which is exactly the record a person is reading when they
 * re-run. Two things make appending safe rather than merely additive:
 *
 * 1. **A run's root attempt id is unique to the run.** It is minted from the
 *    immutable contract (plan id, plan version, ticket key) *and* the number of
 *    runs the ticket has started, so re-running one approved contract mints an
 *    id the record has never held. Without the run count the two runs would
 *    mint the same id and the second's attempts would be indistinguishable from
 *    the first's.
 * 2. **An id already on the record is never written over.** An attempt id
 *    identifies one run of one contract; two records under one id would make
 *    the earlier one unreadable, so a collision is refused with both ids named
 *    rather than resolved by overwriting.
 *
 * Attempts already on the record are carried across as they were written, not
 * re-serialised through this version's schema: a record outlives the version
 * that wrote it, and "never overwritten" has to hold for an entry this binary
 * would no longer produce.
 */

/**
 * An attempt as the record holds it. Only the two fields this module reasons
 * about are named; everything else is carried through untouched.
 */
const StoredAttemptSchema = z.looseObject({
  attempt_id: z.string().min(1),
  /** Absent only on a record written before attempts carried their root. */
  root_attempt_id: z.string().min(1).optional(),
});
export type StoredAttempt = z.infer<typeof StoredAttemptSchema>;

const AttemptsRecordSchema = z.looseObject({
  ticket_id: z.string().min(1),
  attempts: z.array(StoredAttemptSchema),
});
export type AttemptsRecord = z.infer<typeof AttemptsRecordSchema>;

/** The record on disk cannot be read, so nothing may be written over it. */
export class AttemptsRecordError extends Error {}

/** An attempt this run minted has an id the record already holds. */
export class AttemptIdCollisionError extends AttemptsRecordError {}

/**
 * The root attempt id for one run of one contract.
 *
 * The contract is immutable after approval, so the plan id, its version and the
 * ticket key alone identify the *work* rather than the run of it. `runs_started`
 * — the ticket's own count of runs it has begun — is what makes a re-run of the
 * same immutable contract a distinct attempt chain.
 */
export function rootAttemptId(input: {
  plan_id: string;
  plan_version: number;
  ticket_key: string;
  runs_started: number;
}): string {
  return attemptId(
    `${input.plan_id}|${input.plan_version}|${input.ticket_key}|run|${input.runs_started}`,
  );
}

/**
 * The record at `path`, or null where the ticket has never run.
 *
 * A file that exists and cannot be read is an error rather than an empty
 * record: treating it as empty would append to nothing and write the unreadable
 * bytes away.
 */
export function readAttemptsRecord(path: string): AttemptsRecord | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AttemptsRecordError(
      `${path} is not readable JSON, so this run cannot append to it without losing what it ` +
        `holds: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = AttemptsRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AttemptsRecordError(
      `${path} is not a readable attempts record, so this run cannot append to it without ` +
        `losing what it holds:\n  ` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

/**
 * The one run a record written before attempts carried a root can hold. Such a
 * record was replaced by each run rather than appended to, so every attempt in
 * it — every remediation round — belongs to the single run that wrote it. An
 * attempt id is `att_` and sixteen hex digits, so no root can be this.
 */
const RUN_BEFORE_ROOTS = "(the run this record was written by)";

/**
 * The run an attempt belongs to: attempts sharing a root attempt id are one
 * run, and attempts carrying no root are the one run their record held.
 */
const runKey = (attempt: StoredAttempt): string => attempt.root_attempt_id ?? RUN_BEFORE_ROOTS;

/**
 * Each attempt's run number, parallel to the input and numbered in the order
 * the record holds them: the first run's attempts are run 1, the next run's
 * are run 2, whatever their remediation rounds.
 */
export function runNumbers(attempts: readonly StoredAttempt[]): number[] {
  const ordinals = new Map<string, number>();
  return attempts.map((attempt) => {
    const key = runKey(attempt);
    const known = ordinals.get(key);
    if (known !== undefined) return known;
    const ordinal = ordinals.size + 1;
    ordinals.set(key, ordinal);
    return ordinal;
  });
}

/** How many runs the record already holds. */
export function runsOnRecord(record: AttemptsRecord | null): number {
  return new Set((record?.attempts ?? []).map(runKey)).size;
}

/**
 * The last attempt the record holds — the previous run's last attempt, which a
 * new run's first attempt continues from.
 */
export function lastAttemptId(record: AttemptsRecord | null): string | null {
  const attempts = record?.attempts ?? [];
  return attempts[attempts.length - 1]?.attempt_id ?? null;
}

/**
 * The branch the record's last attempt worked on, or null where it names none:
 * the branch a new run of the ticket keeps rather than deriving a new name
 * (D-098).
 */
export function lastAttemptBranch(record: AttemptsRecord | null): string | null {
  const attempts = record?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (last === undefined) return null;
  const parsed = z.looseObject({ branch: z.string().min(1) }).safeParse(last);
  return parsed.success ? parsed.data.branch : null;
}

/**
 * The account the record's last attempt left behind, or null (D-092).
 *
 * What a remediation round in a *new* run is briefed with: the previous run's
 * last attempt is the round's predecessor exactly as the previous round is
 * inside one run. Read from the last attempt only, because an older one
 * describes a change set that has since been re-sealed.
 */
export function lastExecutorAccount(record: AttemptsRecord | null): string | null {
  const attempts = record?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (last === undefined) return null;
  const parsed = z
    .looseObject({ executor_account: z.string().min(1).nullable().optional() })
    .safeParse(last);
  return parsed.success ? (parsed.data.executor_account ?? null) : null;
}

/**
 * The wait the record's last attempt was parked in, or null (SCP-193).
 *
 * A run that sits out a provider's session limit writes the wait onto the
 * attempt **before** it sleeps, so this is what a `run` started after that
 * process was killed reads: the instant the provider named, rather than nothing
 * and an immediate attempt against a limit still in force.
 *
 * Read from the last attempt only. An older one's wait is a wait some run
 * already came back from, and honouring it again would park a run on weather
 * that has passed.
 */
export function parkedWait(record: AttemptsRecord | null): AttemptWait | null {
  const attempts = record?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (last === undefined) return null;
  const parsed = z
    .looseObject({ wait: AttemptWaitSchema.nullable().optional() })
    .safeParse(last);
  return parsed.success ? (parsed.data.wait ?? null) : null;
}

/**
 * The ticket's answer about a base commit: whether that commit passes the
 * manifest's verify command, as an earlier attempt measured it.
 *
 * It lives on the attempts rather than beside them because the attempts record
 * is already the ticket's own append-only history and already the thing every
 * run reads before it provisions — so the answer arrives with the attempt that
 * measured it, and a reader joining a check failure to its attribution has both
 * in one place.
 *
 * Read from the latest attempt that measured the commit asked about. A commit
 * other than that one is a different question, and an attempt that recorded
 * nothing never answers it: an absent answer is unknown, and the review is told
 * so rather than told the base is broken.
 */
export function recordedBaseVerification(
  record: AttemptsRecord | null,
  base_commit: string,
): VerifiedCommit | null {
  const attempts = record?.attempts ?? [];
  const schema = z.looseObject({ base_verification: VerifiedCommitSchema.nullable().optional() });
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const parsed = schema.safeParse(attempts[index]);
    if (!parsed.success) continue;
    const measured = parsed.data.base_verification ?? null;
    if (measured !== null && sameCommit(measured.commit, base_commit)) return measured;
  }
  return null;
}

/**
 * Why two attempt ids may not be the same one.
 *
 * The two ids a collision is between are the same string, so naming them twice
 * tells a reader nothing. What separates the two records is the run either side
 * of the collision — the run whose attempt the record holds and the run that
 * minted the id again — and both are named, because the id alone does not say
 * which record is at risk.
 */
const collision = (args: {
  path: string;
  existing: StoredAttempt;
  minted: string;
  minted_root: string;
  where: string;
}): string =>
  `${args.path} already holds attempt ${args.existing.attempt_id}, recorded by run ` +
  `${args.existing.root_attempt_id ?? "(a run that recorded no root)"}, and this run — root ` +
  `attempt ${args.minted_root} — minted ${args.minted} for ${args.where}. An attempt id ` +
  "identifies one run of one contract, so appending would make the record under that id " +
  "unreadable; the run count the id is minted from has to be one this ticket has not run under.";

/**
 * Refuse a run whose root attempt id is already on the record, before the
 * attempt is provisioned and paid for. The same refusal guards the write, which
 * is where the invariant actually lives; this one only moves it earlier.
 */
export function assertRootAttemptUnused(args: {
  record: AttemptsRecord | null;
  root_attempt_id: string;
  path: string;
}): void {
  const existing = (args.record?.attempts ?? []).find(
    (attempt) => attempt.attempt_id === args.root_attempt_id,
  );
  if (!existing) return;
  throw new AttemptIdCollisionError(
    collision({
      path: args.path,
      existing,
      minted: args.root_attempt_id,
      minted_root: args.root_attempt_id,
      where: "its root attempt",
    }),
  );
}

/**
 * Append this run's attempts to the ticket's record, in the order the run made
 * them, and return what the record then holds.
 *
 * Nothing already on the record is rewritten. An id this run minted that the
 * record already holds — or that this run minted twice — is refused with both
 * ids named, because the alternative is silently losing an attempt.
 */
export function appendAttempts(input: {
  path: string;
  ticket_id: string;
  attempts: readonly ExecutionAttempt[];
}): { attempts: StoredAttempt[]; runs: number } {
  const record = readAttemptsRecord(input.path);
  if (record !== null && record.ticket_id !== input.ticket_id) {
    throw new AttemptsRecordError(
      `${input.path} is the attempts record of ${record.ticket_id}, and this run is ` +
        `${input.ticket_id}. One of the two is looking at the wrong file, and appending would ` +
        "put two tickets' attempts under one ticket id.",
    );
  }
  const prior = record?.attempts ?? [];
  const minted = new Map<string, number>();
  const byId = new Map(prior.map((attempt) => [attempt.attempt_id, attempt]));
  for (const attempt of input.attempts) {
    const existing = byId.get(attempt.attempt_id);
    if (existing !== undefined) {
      throw new AttemptIdCollisionError(
        collision({
          path: input.path,
          existing,
          minted: attempt.attempt_id,
          minted_root: attempt.root_attempt_id,
          where: `round ${attempt.remediation_round}`,
        }),
      );
    }
    const twice = minted.get(attempt.attempt_id);
    if (twice !== undefined) {
      throw new AttemptIdCollisionError(
        `this run minted attempt ${attempt.attempt_id} for round ${twice} and attempt ` +
          `${attempt.attempt_id} again for round ${attempt.remediation_round}. An attempt id ` +
          `identifies one attempt, so ${input.path} cannot hold both.`,
      );
    }
    minted.set(attempt.attempt_id, attempt.remediation_round);
  }

  const attempts: StoredAttempt[] = [...prior, ...input.attempts];
  mkdirSync(dirname(input.path), { recursive: true });
  writeAtomically(
    input.path,
    `${JSON.stringify({ ticket_id: input.ticket_id, attempts }, null, 2)}\n`,
  );
  return { attempts, runs: runsOnRecord({ ticket_id: input.ticket_id, attempts }) };
}

/**
 * Replace the record in one step, or leave what is on disk alone.
 *
 * `rename` within a directory is atomic, so a run killed while it writes leaves
 * the record either as it was or as it now is and never half of each — the same
 * step the spend ledger is replaced by, for the same reason. A half-written
 * record is refused by every later reader, and because the reader refuses
 * rather than starts over, that one file would stop every later run of the
 * ticket.
 */
function writeAtomically(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Which attempt sealed which commit, from the attempts record already on disk.
 *
 * The record is appended to rather than replaced, so this names every commit
 * any run of the ticket sealed — a commit from two runs ago is attributed to
 * the attempt that made it rather than recorded by its sha alone.
 */
export function sealedByAttempt(record: AttemptsRecord | null): Map<string, string> {
  const known = new Map<string, string>();
  const head = z.object({ attempt_id: z.string(), head_commit: z.string().nullable() });
  for (const attempt of record?.attempts ?? []) {
    const parsed = head.safeParse(attempt);
    if (!parsed.success || parsed.data.head_commit === null) continue;
    known.set(parsed.data.head_commit, parsed.data.attempt_id);
  }
  return known;
}

/**
 * The commit this ticket's spec is in, as its attempts record names it, or
 * null where no run has made one (D-103).
 *
 * Read from the record rather than derived from the branch, because the
 * question a resumed run asks is whether the branch still starts where the
 * record says it does — and a branch is not evidence about itself.
 */
export function specCommitOnRecord(record: AttemptsRecord | null): string | null {
  const shape = z.object({ spec_commit: z.string().nullable().optional() });
  for (const attempt of [...(record?.attempts ?? [])].reverse()) {
    const parsed = shape.safeParse(attempt);
    if (parsed.success && parsed.data.spec_commit) return parsed.data.spec_commit;
  }
  return null;
}
