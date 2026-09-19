import { hostname } from "node:os";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AttemptWaitSchema, type AttemptWait } from "@perbo/contracts";

/**
 * One run per ticket at a time (SCP-193).
 *
 * A run can now sit out a provider's session limit for hours, which turns a
 * question nobody had to ask into one somebody will: *is this ticket already
 * running?* Without an answer, the second `perbo run` provisions a second
 * worktree on the same branch, mints attempt ids the first run is about to
 * mint, and one of the two loses its attempts record to a collision — after
 * both have paid for an executor.
 *
 * So a run takes a lock file beside the attempts record it is about to append
 * to, and a second run is refused with what the first is doing: its pid, when
 * it started, and the wait it is in where it is parked in one. The refusal
 * names those because "it is already running" without them is a sentence a
 * person can only act on by hunting for a process.
 *
 * **Stale by pid.** The lock is a file, and a killed run leaves one behind.
 * A lock whose pid names no live process on this host is stale and is taken
 * over; a lock written by another host is not, because this process cannot
 * ask that host anything and a lock it cannot verify is one it must not break.
 */

const RunLockSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  ticket_id: z.string().min(1),
  /** What a person calls the ticket, for the refusal to name it as they do. */
  ticket_key: z.string().min(1),
  started_at: z.iso.datetime(),
  /** The wait the run is sitting out right now, or null when it is working. */
  wait: AttemptWaitSchema.nullable().default(null),
});
export type RunLock = z.infer<typeof RunLockSchema>;

/** The lock file for one ticket, under the state root the loop already writes. */
export const runLockPath = (state_root: string, ticket_id: string): string =>
  join(state_root, `${ticket_id}.lock.json`);

/** A run of this ticket is already in progress, and this is what it is doing. */
export class RunLockedError extends Error {
  readonly held: RunLock;
  readonly path: string;

  constructor(held: RunLock, path: string, now: Date) {
    super(
      `${held.ticket_key} is already running: pid ${held.pid} on ${held.host}, started ` +
        `${held.started_at}` +
        (held.wait === null
          ? ". Wait for it to finish, or stop it and run again"
          : `, and ${describeWait(held.wait, now)}. It resumes on its own; stop that process if ` +
            "you want to run now") +
        ` (the lock is ${path}, and a run that ended leaves none)`,
    );
    this.name = "RunLockedError";
    this.held = held;
    this.path = path;
  }
}

/** The wait a held lock is in, as the refusal states it. */
function describeWait(wait: AttemptWait, now: Date): string {
  const remaining = Date.parse(wait.until) - now.getTime();
  const minutes = Math.max(0, Math.round(remaining / 60_000));
  return (
    `parked until ${wait.until} (${wait.zone}) on a ${wait.reason.replace(/_/g, " ")}` +
    (remaining > 0 ? `, ${minutes} minute(s) from now` : ", which has passed")
  );
}

/** The lock a ticket currently holds, or null where the file is absent or unreadable. */
export function readRunLock(path: string): RunLock | null {
  if (!existsSync(path)) return null;
  try {
    return RunLockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A lock nobody can read locks nothing: it names no pid to check and no
    // wait to report, so it is treated as the leftover it is.
    return null;
  }
}

/**
 * Whether the process a lock names is still alive **on this host**.
 *
 * `kill(pid, 0)` sends no signal and answers only the question. `EPERM` is a
 * process this user may not signal, which is still a process; `ESRCH` is none.
 */
function alive(lock: { pid: number; host: string }): boolean {
  if (lock.host !== hostname()) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HeldRunLock {
  path: string;
  /** Record the wait this run has entered, so a second `run` can report it. */
  parked(wait: AttemptWait | null): void;
  /** Remove the lock. Safe to call twice; a run that ended leaves no file. */
  release(): void;
}

/**
 * Take the ticket's run lock, or refuse with what holds it.
 *
 * The create is exclusive (`wx`), so two runs starting at once cannot both
 * believe they took it: the loser reads the winner's file rather than
 * overwriting it.
 */
export function acquireRunLock(args: {
  state_root: string;
  ticket_id: string;
  ticket_key: string;
  now: Date;
  pid?: number;
}): HeldRunLock {
  const path = runLockPath(args.state_root, args.ticket_id);
  const lock: RunLock = {
    pid: args.pid ?? process.pid,
    host: hostname(),
    ticket_id: args.ticket_id,
    ticket_key: args.ticket_key,
    started_at: args.now.toISOString(),
    wait: null,
  };

  let held = lock;
  const write = (exclusive: boolean): boolean => writeLockFile(path, held, exclusive);

  if (!write(true)) {
    const existing = readRunLock(path);
    if (existing !== null && alive(existing)) throw new RunLockedError(existing, path, args.now);
    // Stale, or unreadable: the run that wrote it is gone, so this one takes
    // the file over rather than refusing on a process that no longer exists.
    write(false);
  }

  return {
    path,
    parked(wait) {
      held = { ...held, wait };
      write(false);
    },
    release() {
      // Only this run's own lock: a file another run has since taken over is
      // that run's to remove, and deleting it would unlock a live run.
      const current = readRunLock(path);
      if (current !== null && (current.pid !== held.pid || current.host !== held.host)) return;
      rmSync(path, { force: true });
    },
  };
}

/**
 * Write one lock file, exclusively or over an existing one.
 *
 * `wx` is what makes two processes starting at once unable to both believe
 * they took it: the loser reads the winner's file rather than overwriting it.
 * Returns false only for that case; every other failure throws.
 */
function writeLockFile(path: string, held: unknown, exclusive: boolean): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, exclusive ? "wx" : "w");
  } catch (error) {
    if (exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(held, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * One loop merge per base at a time (SCP-202 criterion 3).
 *
 * Phase 1 runs one ticket at a time, in the founder's words, so the step
 * refuses rather than queues: two merges into one base are two branches whose
 * mergeability was read before the other landed, and the second one's read is
 * stale by the time it merges. A queue that re-levels and re-checks the next
 * branch after each merge is SCP-227, and it is not this.
 *
 * Beside the ticket's run lock and stale the same way — by pid, on this host
 * only — because a killed merge leaves a file behind and a lock this process
 * cannot verify is one it must not break.
 */
const MergeLockSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  /** The base this merge is into: one lock per base, not per repository. */
  base_ref: z.string().min(1),
  /** What a person calls the ticket being merged, for the refusal to name it. */
  ticket_key: z.string().min(1),
  started_at: z.iso.datetime(),
});
export type MergeLock = z.infer<typeof MergeLockSchema>;

/**
 * The lock file for one base, under the state root the loop already writes.
 *
 * The base ref is reduced to path-safe characters: it is a person's
 * configuration rather than model output, but it legitimately contains `/`
 * (`release/2026-09`), which would name a directory rather than a lock.
 */
export const mergeLockPath = (state_root: string, base_ref: string): string =>
  join(state_root, `merge.${base_ref.replace(/[^A-Za-z0-9._-]/g, "-")}.lock.json`);

/** A loop merge into this base is already in flight, and this is whose. */
export class MergeLockedError extends Error {
  readonly held: MergeLock;
  readonly path: string;

  constructor(held: MergeLock, path: string) {
    super(
      `a loop merge into ${held.base_ref} is already in flight: ${held.ticket_key}, pid ${held.pid} ` +
        `on ${held.host}, started ${held.started_at}. Phase 1 merges one at a time; wait for it to ` +
        `finish, or stop it and merge again (the lock is ${path}, and a merge that ended leaves none)`,
    );
    this.name = "MergeLockedError";
    this.held = held;
    this.path = path;
  }
}

/** The merge lock a base currently holds, or null where it is absent or unreadable. */
export function readMergeLock(path: string): MergeLock | null {
  if (!existsSync(path)) return null;
  try {
    return MergeLockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A lock nobody can read locks nothing: it names no pid to check, so it is
    // treated as the leftover it is.
    return null;
  }
}

export interface HeldMergeLock {
  path: string;
  /** Remove the lock. Safe to call twice; a merge that ended leaves no file. */
  release(): void;
}

/** Take the base's merge lock, or refuse with what holds it. */
export function acquireMergeLock(args: {
  state_root: string;
  base_ref: string;
  ticket_key: string;
  now: Date;
  pid?: number;
}): HeldMergeLock {
  const path = mergeLockPath(args.state_root, args.base_ref);
  const held: MergeLock = {
    pid: args.pid ?? process.pid,
    host: hostname(),
    base_ref: args.base_ref,
    ticket_key: args.ticket_key,
    started_at: args.now.toISOString(),
  };

  if (!writeLockFile(path, held, true)) {
    const existing = readMergeLock(path);
    if (existing !== null && alive(existing)) throw new MergeLockedError(existing, path);
    // Stale, or unreadable: the merge that wrote it is gone, so this one takes
    // the file over rather than refusing on a process that no longer exists.
    writeLockFile(path, held, false);
  }

  return {
    path,
    release() {
      // Only this merge's own lock: a file another merge has since taken over
      // is that merge's to remove.
      const current = readMergeLock(path);
      if (current !== null && (current.pid !== held.pid || current.host !== held.host)) return;
      rmSync(path, { force: true });
    },
  };
}

/**
 * Every run lock under the state root whose process is still alive (SCP-227).
 *
 * `perbo serve` counts these against `concurrent_local_attempts` so a run a
 * person started by hand takes a place in the same count as one the queue
 * started: the ceiling is about the laptop, not about who typed the command.
 * A stale lock is a run that ended without cleaning up, and counts for nothing.
 */
const SERVE_LOCK_FILE = "serve.lock.json";

export function liveRunLocks(state_root: string): RunLock[] {
  if (!existsSync(state_root)) return [];
  const live: RunLock[] = [];
  for (const name of readdirSync(state_root)) {
    if (!name.endsWith(".lock.json") || name.startsWith("merge.") || name === SERVE_LOCK_FILE) continue;
    const lock = readRunLock(join(state_root, name));
    if (lock !== null && alive(lock)) live.push(lock);
  }
  return live;
}

/**
 * One `perbo serve` per store (SCP-227).
 *
 * Two queues over one store would each read the same `ready` ticket and both
 * start it; the run lock would refuse the second, after both had paid for the
 * scheduling and one had been told a ticket it did not start was running.
 * Stale the same way as the other two locks: by pid, on this host only.
 */

const ServeLockSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  /** The checkout the queue schedules, for the refusal to name it. */
  repository_root: z.string().min(1),
  started_at: z.iso.datetime(),
});
export type ServeLock = z.infer<typeof ServeLockSchema>;

export const serveLockPath = (state_root: string): string => join(state_root, SERVE_LOCK_FILE);

/** A queue is already running over this store, and this is which. */
export class ServeLockedError extends Error {
  readonly held: ServeLock;
  readonly path: string;

  constructor(held: ServeLock, path: string) {
    super(
      `a queue is already running over ${held.repository_root}: pid ${held.pid} on ${held.host}, ` +
        `started ${held.started_at}. One \`perbo serve\` per store; stop that one to start another ` +
        `(the lock is ${path}, and a queue that ended leaves none)`,
    );
    this.name = "ServeLockedError";
    this.held = held;
    this.path = path;
  }
}

/** The serve lock a store currently holds, or null where it is absent or unreadable. */
export function readServeLock(path: string): ServeLock | null {
  if (!existsSync(path)) return null;
  try {
    return ServeLockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export interface HeldServeLock {
  path: string;
  /** Remove the lock. Safe to call twice; a queue that ended leaves no file. */
  release(): void;
}

/** Take the store's serve lock, or refuse with what holds it. */
export function acquireServeLock(args: {
  state_root: string;
  repository_root: string;
  now: Date;
  pid?: number;
}): HeldServeLock {
  const path = serveLockPath(args.state_root);
  const held: ServeLock = {
    pid: args.pid ?? process.pid,
    host: hostname(),
    repository_root: args.repository_root,
    started_at: args.now.toISOString(),
  };

  if (!writeLockFile(path, held, true)) {
    const existing = readServeLock(path);
    if (existing !== null && alive(existing)) throw new ServeLockedError(existing, path);
    writeLockFile(path, held, false);
  }

  return {
    path,
    release() {
      const current = readServeLock(path);
      if (current !== null && (current.pid !== held.pid || current.host !== held.host)) return;
      rmSync(path, { force: true });
    },
  };
}
