import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { driftPath, hasAcceptanceCriteria, type PlanContract } from "@perbo/contracts";
import { DriftRecordSchema, promiseTexts, type DriftRecord } from "@perbo/planning";
import { UsageError } from "../usage-error.js";
import { readContract } from "./tickets.js";

/**
 * `<KEY>.drift.json`: the plan read against the spec it was drafted from, kept
 * beside the ticket against two hashes — the spec's bytes and the plan's
 * promise texts — so it holds while neither moves
 * ([D-128](../../../../docs/11-open-decisions.md)).
 *
 * Admission seeds it, because a plan just drafted agrees with its spec by
 * construction; a chat turn that moved the plan under the interview's guard
 * carries it forward; a hand edit lets it go, and the next reading is
 * `perbo drift`'s.
 */

export const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** `.perbo/tickets/<KEY>.drift.json`, beside the ticket's other records. */
export function driftRecordPath(dir: string, key: string): string {
  return join(dir, ...driftPath(key));
}

/**
 * The record beside a ticket: null where none has been written, and a
 * `UsageError` naming the file where one is there and is not a record — the
 * same hand edit the counter-seal catches on the contract, said in words a
 * person can act on rather than as a parse error.
 */
export function readDriftRecord(dir: string, key: string): DriftRecord | null {
  const path = driftRecordPath(dir, key);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = DriftRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a drift record:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

export function writeDriftRecord(dir: string, key: string, record: DriftRecord): void {
  const path = driftRecordPath(dir, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DriftRecordSchema.parse(record), null, 2)}\n`);
}

/** The two hashes a verdict is kept against. */
export interface DriftKey {
  spec: string;
  promises: string;
}

/**
 * The state of the pair now: the spec's bytes as they are on disk, and the
 * plan's promise texts as `promiseTexts` orders them. A P0 contract has no
 * criteria, so its promise is its outcome alone.
 *
 * The spec is read as bytes and never as parsed text: the hash is a question
 * about whether the file moved, and a parse that tolerated a change would
 * answer it wrongly. Throws whatever the read throws; the caller says what an
 * unreadable spec means where it stands.
 */
export function driftKeyFor(args: {
  repositoryRoot: string;
  /** The spec's path, repository-relative, as the admission record carries it. */
  specPath: string;
  contract: PlanContract;
}): DriftKey {
  return {
    spec: sha256(readFileSync(resolve(args.repositoryRoot, args.specPath))),
    promises: promisesHash(args.contract),
  };
}

/** The plan's half of the key: its promise texts, in `promiseTexts`'s order. */
export const promisesHash = (contract: PlanContract): string =>
  sha256(JSON.stringify(promiseTexts(planPromise(contract))));

/** What the reading is given of the plan: the outcome and each criterion's words. */
export function planPromise(contract: PlanContract): {
  outcome: string;
  criteria: { id: string; text: string; requirement_id: string | null }[];
} {
  return {
    outcome: contract.outcome,
    criteria: hasAcceptanceCriteria(contract)
      ? contract.acceptance_criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          requirement_id: criterion.requirement_id ?? null,
        }))
      : [],
  };
}

/**
 * The verdict a plan has as it is drafted: nothing parted, because the plan
 * was just written from the spec. Admission writes this whenever it writes a
 * draft snapshot for a spec source, so the first visit to the page finds a
 * record and calls no model.
 */
export function seedDrift(args: {
  dir: string;
  key: string;
  repositoryRoot: string;
  specPath: string;
  contract: PlanContract;
  now: Date;
}): void {
  writeDriftRecord(args.dir, args.key, {
    ...driftKeyFor(args),
    origin: "drafted",
    findings: [],
    dismissed: false,
    checked_at: args.now.toISOString(),
    model: null,
  });
}

/**
 * Bring a clean verdict forward past a chat turn that moved the plan.
 *
 * Three things have to hold: a record is there, it is the one the turn began
 * from, and it found nothing. The second is what makes "a chat edit never
 * triggers the reading" a fact rather than a hope: a hand edit made before
 * the turn left the record at hashes the turn did not begin from, so the
 * record stays where it is and the page reads the hand edit. The third is
 * that findings are about words, and a turn that moved the words has made
 * them stale either way — a record with findings is left for the page to
 * read again.
 *
 * Nothing is written where the key did not move: an arrangement edit leaves
 * the record holding as it is.
 */
export function carryDrift(args: {
  dir: string;
  key: string;
  repositoryRoot: string;
  specPath: string;
  /** The hashes as the turn began. */
  before: DriftKey;
  now: Date;
}): void {
  const record = readDriftRecord(args.dir, args.key);
  if (record === null) return;
  if (record.spec !== args.before.spec || record.promises !== args.before.promises) return;
  if (record.findings.length > 0) return;
  const after = driftKeyFor({
    repositoryRoot: args.repositoryRoot,
    specPath: args.specPath,
    contract: readContract(args.dir, args.key),
  });
  if (after.spec === record.spec && after.promises === record.promises) return;
  writeDriftRecord(args.dir, args.key, {
    ...after,
    origin: "carried",
    findings: [],
    dismissed: false,
    checked_at: args.now.toISOString(),
    model: null,
  });
}

