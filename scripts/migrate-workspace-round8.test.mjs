// migrate-workspace-round8.mjs against a fixture profile in a temporary
// directory, run as the founder runs it: a process started with argv.
//
//   node --test scripts/migrate-workspace-round8.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "./migrate-workspace-round8.mjs";

const SCRIPT = fileURLToPath(new URL("./migrate-workspace-round8.mjs", import.meta.url));

/** An editing session as a profile from before the planning records holds it. */
function older(id, over = {}) {
  return {
    version: 1,
    id,
    repoId: "repo-1",
    key: "PRB-1",
    admitted: true,
    digest: null,
    revision: 3,
    resumeNew: false,
    specSlug: "a-spec",
    specCut: null,
    named: null,
    asking: null,
    nodes: 0,
    drift: null,
    change: null,
    lastPane: "criteria",
    lastView: "contract",
    phase: "ready",
    error: null,
    operation: null,
    history: [],
    conversation: [],
    interviewSession: null,
    interviewProvider: null,
    interviewModel: null,
    ...over,
  };
}

/** A profile directory holding `workspace.json` with these sessions. */
function profile(sessions) {
  const dir = mkdtempSync(join(tmpdir(), "perbo-migrate-"));
  const state = { version: 1, settings: { name: "Owen" }, repositories: [], jobs: [], editingSessions: sessions };
  writeFileSync(join(dir, "workspace.json"), `${JSON.stringify(state, null, 2)}\n`);
  return dir;
}

const node = (...argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8" });

test("brings every editing session up to the records, backs the file up first and prints each change", () => {
  const change = { at: "2026-09-21T10:00:00.000Z", spec: null, plan: null };
  const dir = profile([
    older("s-1", { change }),
    older("s-2", { lastPane: "graph", lastView: null, confirmed: "0011223344556677", read: null, impact: 2, change: { ...change, by: "chat" } }),
  ]);
  const file = join(dir, "workspace.json");
  const before = readFileSync(file, "utf8");
  const printed = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" }).trim().split("\n");
  assert.equal(readFileSync(`${file}.bak`, "utf8"), before);
  const after = JSON.parse(readFileSync(file, "utf8"));
  const [first, second] = after.editingSessions;
  assert.equal("lastView" in first, false);
  assert.equal(first.confirmed, null);
  assert.equal(first.read, null);
  assert.equal(first.impact, null);
  assert.equal(first.lastPane, null);
  assert.equal(first.change, null);
  // What was already current stays as it was, lastView aside.
  assert.equal("lastView" in second, false);
  assert.equal(second.lastPane, "graph");
  assert.equal(second.confirmed, "0011223344556677");
  assert.equal(second.impact, 2);
  assert.deepEqual(second.change, { ...change, by: "chat" });
  // The rest of the profile is untouched.
  assert.deepEqual(after.settings, { name: "Owen" });
  assert.deepEqual(printed, [
    `${file}: backed up to ${file}.bak`,
    "session s-1: deleted lastView",
    "session s-1: added confirmed: null",
    "session s-1: added read: null",
    "session s-1: added impact: null",
    'session s-1: set lastPane "criteria" to null',
    "session s-1: set a change that names no author to null",
    "session s-2: deleted lastView",
  ]);
});

test("takes the file itself as well as its directory, and changes nothing a second time", () => {
  const dir = profile([older("s-1")]);
  const file = join(dir, "workspace.json");
  assert.equal(node(file).status, 0);
  const migrated = readFileSync(file, "utf8");
  const again = node(file);
  assert.equal(again.status, 0);
  assert.equal(again.stdout.trim(), `${file}: nothing to change`);
  assert.equal(readFileSync(file, "utf8"), migrated);
});

test("leaves a profile that needs nothing without a backup", () => {
  const dir = profile([]);
  assert.equal(node(dir).stdout.trim(), `${join(dir, "workspace.json")}: nothing to change`);
  assert.equal(existsSync(join(dir, "workspace.json.bak")), false);
});

test("says how it is used when it is not given exactly one path, and fails on a file it cannot read", () => {
  for (const argv of [[], ["one", "two"]]) {
    const refused = node(...argv);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^usage: node scripts\/migrate-workspace-round8\.mjs /);
  }
  const missing = node(join(tmpdir(), "perbo-no-such-profile", "workspace.json"));
  assert.equal(missing.status, 1);
});

test("does not modify the state it is handed", () => {
  const state = { editingSessions: [older("s-1")] };
  const held = structuredClone(state);
  const { changes } = migrate(state);
  assert.ok(changes.length > 0);
  assert.deepEqual(state, held);
});
