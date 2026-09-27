import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * One writer at a time for a record the store keeps whole.
 *
 * Commands over different tickets run at the same time (D-049), and a record
 * the whole store shares — `verdicts.json` — is changed by reading it, adding
 * to it and writing it back. Two of those at once each read the file before
 * the other wrote, and the second write drops the first one's row. So the
 * change is made under a lock beside the record, and the record is read again
 * under it: the writes are serialised, and each one starts from the last.
 *
 * The lock has the run lock's shape: a file naming the pid and host that hold
 * it, created exclusively, and stale by pid on this host only, because a lock
 * written by another host names a process this one cannot ask about. It is
 * written whole to a temporary and linked into place, so a waiter never reads
 * a lock that exists but is still empty.
 *
 * A writer holds it for milliseconds, so a waiter polls for a short bound and
 * then refuses with what holds it rather than writing without it.
 */

const RecordLockSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  /** This holder's own, so a lock read twice can be told from one taken again in between. */
  token: z.string().min(1),
  taken_at: z.iso.datetime(),
});
export type RecordLock = z.infer<typeof RecordLockSchema>;

/** How long a writer waits for the lock before it refuses. */
export const RECORD_LOCK_WAIT_MS = 5_000;

export const recordLockPath = (record: string): string => `${record}.lock`;

/**
 * The lock was still held when the wait ran out, and nothing was written.
 * `held` is null where the lock could not be read.
 */
export class RecordLockedError extends Error {
  readonly record: string;
  readonly path: string;
  readonly held: RecordLock | null;

  constructor(record: string, path: string, held: RecordLock | null, waitedMs: number) {
    const breaker = breakerPath(path);
    super(
      `${record} is being written by ` +
        (held === null ? "a process the lock does not name" : `pid ${held.pid} on ${held.host} since ${held.taken_at}`) +
        `, and was still held after ${waitedMs / 1000}s; nothing was recorded. Run it again, or, where ` +
        `that process is gone, remove ${path}` +
        (existsSync(breaker) ? ` and ${breaker}` : ""),
    );
    this.name = "RecordLockedError";
    this.record = record;
    this.path = path;
    this.held = held;
  }
}

/**
 * Run `change` holding the lock on `record`, and release it after, whether
 * `change` returned or threw. `change` reads the record itself: what it read
 * before the lock was taken is what another writer may already have replaced.
 */
export function withRecordLock<T>(
  record: string,
  now: Date,
  change: () => T,
  waitMs: number = RECORD_LOCK_WAIT_MS,
): T {
  const path = recordLockPath(record);
  const mine: RecordLock = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    taken_at: now.toISOString(),
  };
  mkdirSync(dirname(record), { recursive: true });
  acquire(record, path, mine, waitMs);
  try {
    return change();
  } finally {
    // Only this writer's own: a lock that names another holder is theirs.
    if (readRecordLock(path)?.token === mine.token) rmSync(path, { force: true });
  }
}

function acquire(record: string, path: string, mine: RecordLock, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (create(path, mine)) return;
    const held = readRecordLock(path);
    // A lock nobody can read names no pid to check, and one whose process is
    // gone from this host holds nothing: either is cleared and taken.
    if ((held === null || !alive(held)) && clearStale(path, held)) continue;
    if (Date.now() >= deadline) throw new RecordLockedError(record, path, held, waitMs);
    pause(10 + Math.floor(Math.random() * 20));
  }
}

/** Link a complete lock file into place, or return false where one is already there. */
function create(path: string, lock: RecordLock): boolean {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The lock on the record, or null where it is absent or unreadable. */
export function readRecordLock(path: string): RecordLock | null {
  try {
    return RecordLockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

const breakerPath = (path: string): string => `${path}.clearing`;

/**
 * Remove a stale lock, where it is still the one that was judged stale.
 *
 * Two waiters that judged the same lock stale must not both remove it: the
 * first removes it and takes the record, and the second's removal would then
 * take away a live lock. So clearing is itself exclusive — one clearer at a
 * time, through a file created with `wx` — and the clearer reads the lock again
 * before it removes it. Returns false where another waiter is clearing it.
 */
function clearStale(path: string, judged: RecordLock | null): boolean {
  const breaker = breakerPath(path);
  let handle: number;
  try {
    handle = openSync(breaker, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  closeSync(handle);
  try {
    const current = readRecordLock(path);
    const same = judged === null ? current === null : current?.token === judged.token;
    if (same) {
      // Moved aside rather than removed, so a lock that vanished in between is
      // an ENOENT here rather than a removal of whatever stands there now.
      const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(path, aside);
        rmSync(aside, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    rmSync(breaker, { force: true });
  }
  return true;
}

/**
 * Whether the process a lock names is still alive on this host. `kill(pid, 0)`
 * sends no signal; `EPERM` is a process this user may not signal, which is
 * still a process.
 */
function alive(lock: RecordLock): boolean {
  if (lock.host !== hostname()) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms`: the command's write is synchronous, and so is its wait. */
function pause(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}
