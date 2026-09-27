import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { exitForThrown } from "../command-line/terminal.js";
import { RecordLockedError, recordLockPath, withRecordLock, type RecordLock } from "./record-lock.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-record-lock-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NOW = new Date("2026-09-04T10:11:12.000Z");

function lockHeldBy(record: string, pid: number, host = hostname()): RecordLock {
  const lock: RecordLock = { pid, host, token: `token-${pid}`, taken_at: NOW.toISOString() };
  writeFileSync(recordLockPath(record), `${JSON.stringify(lock)}\n`);
  return lock;
}

/** A pid that named a process a moment ago and names none now. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

describe("withRecordLock", () => {
  it("refuses in the CLI's words, and runs nothing, while a live process holds the lock", () => {
    const record = join(scratch, "held", "verdicts.json");
    let ran = false;
    withRecordLock(record, NOW, () => undefined);
    lockHeldBy(record, process.pid);

    let thrown: unknown;
    try {
      withRecordLock(record, NOW, () => (ran = true), 50);
    } catch (error) {
      thrown = error;
    }

    expect(ran).toBe(false);
    expect(thrown).toBeInstanceOf(RecordLockedError);
    const failure = exitForThrown("verdict", thrown);
    expect(failure.code).toBe(EXIT_CODES.did_not_complete);
    expect(failure.message).toBe(
      `\`perbo verdict\` did not complete: ${record} is being written by pid ${process.pid} on ${hostname()} ` +
        `since ${NOW.toISOString()}, and was still held after 0.05s; nothing was recorded. Run it again, or, ` +
        `where that process is gone, remove ${recordLockPath(record)}.`,
    );
    // The holder's lock is still its own.
    expect(existsSync(recordLockPath(record))).toBe(true);
  });

  it("treats a lock written by another host as held, since this one cannot ask about its process", () => {
    const record = join(scratch, "elsewhere", "verdicts.json");
    withRecordLock(record, NOW, () => undefined);
    lockHeldBy(record, exitedPid(), "another-host.invalid");
    expect(() => withRecordLock(record, NOW, () => undefined, 50)).toThrow(RecordLockedError);
  });

  it("clears a lock whose process is gone from this host, and takes it", () => {
    const record = join(scratch, "stale", "verdicts.json");
    withRecordLock(record, NOW, () => undefined);
    lockHeldBy(record, exitedPid());

    expect(withRecordLock(record, NOW, () => "written", 50)).toBe("written");
    expect(readdirSync(join(scratch, "stale"))).toEqual([]);
  });

  it("clears a lock nobody can read, since it names no process to wait for", () => {
    const record = join(scratch, "unreadable", "verdicts.json");
    withRecordLock(record, NOW, () => undefined);
    writeFileSync(recordLockPath(record), "{");

    expect(withRecordLock(record, NOW, () => "written", 50)).toBe("written");
    expect(existsSync(recordLockPath(record))).toBe(false);
  });

  it("releases the lock when the change throws", () => {
    const record = join(scratch, "throws", "verdicts.json");
    expect(() =>
      withRecordLock(record, NOW, () => {
        expect(existsSync(recordLockPath(record))).toBe(true);
        throw new Error("the change failed");
      }),
    ).toThrow("the change failed");
    expect(readdirSync(join(scratch, "throws"))).toEqual([]);
  });
});
