import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { driftHash, driftRecordPath, readDriftRecord, writeDriftRecord } from "./drift-record.js";
import type { DriftRecord } from "./drift-report.js";
import { PlanningError } from "./errors.js";

const stores: string[] = [];
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-drift-record-"));
  stores.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record: DriftRecord = {
  spec: driftHash("# Spec\n"),
  promises: driftHash(JSON.stringify(["New users receive an activation email."])),
  origin: "drafted",
  findings: [],
  dismissed: false,
  checked_at: "2026-09-23T10:00:00.000Z",
  model: null,
};

describe("the drift record on disk", () => {
  it("reads back what it wrote, at the ticket's own place in the store", () => {
    const dir = store();
    expect(readDriftRecord(dir, "PRB-1")).toBeNull();
    writeDriftRecord(dir, "PRB-1", record);
    expect(driftRecordPath(dir, "PRB-1")).toBe(join(dir, "tickets", "PRB-1.drift.json"));
    expect(JSON.parse(readFileSync(join(dir, "tickets", "PRB-1.drift.json"), "utf8"))).toEqual(record);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(record);
  });

  it("refuses a record that is not one, naming the file, and writes none", () => {
    const dir = store();
    mkdirSync(join(dir, "tickets"));
    writeFileSync(driftRecordPath(dir, "PRB-1"), '{"spec": "not a hash"}\n');
    expect(() => readDriftRecord(dir, "PRB-1")).toThrow(PlanningError);
    expect(() => readDriftRecord(dir, "PRB-1")).toThrow(/PRB-1\.drift\.json is not a drift record/);
    writeFileSync(driftRecordPath(dir, "PRB-1"), "{ not json");
    expect(() => readDriftRecord(dir, "PRB-1")).toThrow(/could not read .*PRB-1\.drift\.json/);
    expect(() => writeDriftRecord(dir, "PRB-2", { ...record, spec: "sha256:short" })).toThrow();
    expect(readDriftRecord(dir, "PRB-2")).toBeNull();
  });

  it("refuses a record reached through a link, dangling or not", () => {
    const dir = store();
    const elsewhere = store();
    writeDriftRecord(elsewhere, "PRB-1", record);
    mkdirSync(join(dir, "tickets"));
    symlinkSync(driftRecordPath(elsewhere, "PRB-1"), driftRecordPath(dir, "PRB-1"));
    expect(() => readDriftRecord(dir, "PRB-1")).toThrow(/is a symlink/);
    expect(() => writeDriftRecord(dir, "PRB-1", record)).toThrow(/is a symlink/);
    symlinkSync(join(elsewhere, "nowhere.json"), driftRecordPath(dir, "PRB-2"));
    expect(() => writeDriftRecord(dir, "PRB-2", record)).toThrow(/is a symlink/);
  });
});
