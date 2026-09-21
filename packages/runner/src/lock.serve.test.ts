import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ServeLockedError,
  acquireRunLock,
  acquireServeLock,
  liveRunLocks,
  readServeLock,
  runLockPath,
  serveLockPath,
} from "./lock.js";

/**
 * SCP-227: one queue per store, and the queue's count of what is running
 * includes runs it did not start.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-serve-lock-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A pid no process on this host holds: above the kernel's range on every platform this runs on. */
const DEAD_PID = 2_147_483_647;

const now = new Date("2026-09-10T12:00:00.000Z");

describe("the serve lock", () => {
  it("refuses a second queue over the same store, naming the first", () => {
    const state_root = join(scratch, "one");
    const held = acquireServeLock({ state_root, repository_root: "/repo", now });
    expect(readServeLock(serveLockPath(state_root))?.pid).toBe(process.pid);
    expect(() => acquireServeLock({ state_root, repository_root: "/repo", now })).toThrow(ServeLockedError);
    expect(() => acquireServeLock({ state_root, repository_root: "/repo", now })).toThrow(String(process.pid));
    held.release();
    expect(readServeLock(serveLockPath(state_root))).toBeNull();
    // Released, so the next queue takes it.
    acquireServeLock({ state_root, repository_root: "/repo", now }).release();
  });

  it("takes over a lock whose process is gone", () => {
    const state_root = join(scratch, "stale");
    const path = serveLockPath(state_root);
    const dead = acquireServeLock({ state_root, repository_root: "/repo", now, pid: DEAD_PID });
    void dead; // never released: the queue that wrote it is gone
    // The dead queue's file is still there.
    expect(readServeLock(path)?.pid).toBe(DEAD_PID);
    const held = acquireServeLock({ state_root, repository_root: "/repo", now });
    expect(readServeLock(path)?.pid).toBe(process.pid);
    held.release();
  });

  it("does not release a lock another queue has since taken over", () => {
    const state_root = join(scratch, "handover");
    const first = acquireServeLock({ state_root, repository_root: "/repo", now, pid: DEAD_PID });
    const second = acquireServeLock({ state_root, repository_root: "/repo", now });
    first.release();
    expect(readServeLock(serveLockPath(state_root))?.pid).toBe(process.pid);
    second.release();
  });
});

describe("liveRunLocks", () => {
  it("counts the runs whose process is alive and nothing else", () => {
    const state_root = join(scratch, "runs");
    const live = acquireRunLock({ state_root, ticket_id: "ticket_live", ticket_key: "AYO-1", now });
    acquireRunLock({ state_root, ticket_id: "ticket_dead", ticket_key: "AYO-2", now, pid: DEAD_PID });
    // A merge lock and the serve lock live in the same directory and are not runs.
    writeFileSync(
      join(state_root, "merge.main.lock.json"),
      JSON.stringify({ pid: process.pid, host: hostname(), base_ref: "main", ticket_key: "AYO-3", started_at: now.toISOString() }),
    );
    const serve = acquireServeLock({ state_root, repository_root: "/repo", now });
    // And a file nothing can read locks nothing.
    writeFileSync(runLockPath(state_root, "ticket_garbage"), "{");

    expect(liveRunLocks(state_root).map((lock) => lock.ticket_key)).toEqual(["AYO-1"]);
    live.release();
    serve.release();
    expect(liveRunLocks(state_root)).toEqual([]);
  });

  it("is empty for a state root that does not exist yet", () => {
    expect(liveRunLocks(join(scratch, "absent"))).toEqual([]);
  });
});
