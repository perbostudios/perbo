// Brings a desktop profile's `workspace.json` up to the planning records the
// desktop reads (D-130, D-NEW-basic-and-epic-flows, D-128). A profile that
// fails the schema stops Perbo from starting, so this runs before the first
// start of a build that reads them. For every editing session it:
//
// - deletes `lastView`, which the contract tab's `confirmed` replaces;
// - adds `confirmed`, `read` and `impact` as null where the session has none;
// - sets a `lastPane` of "criteria", a pane planning no longer has, to null,
//   so the planning reopens where it otherwise lands;
// - sets a recorded `change` that does not say who made it to null, since the
//   panes mark only a change the chat made and this one cannot say.
//
// The file is copied to `<file>.bak` before it is written, and each change is
// printed. A profile that needs nothing is left as it is, with no backup.
//
//   node scripts/migrate-workspace-round8.mjs <profile directory or its workspace.json>

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the profile's record is: the file named, or `workspace.json` in the directory named. */
export function profileFile(path) {
  const named = resolve(path);
  return existsSync(named) && statSync(named).isDirectory() ? join(named, "workspace.json") : named;
}

/**
 * The profile's state with every editing session brought up to the records,
 * and one line for each thing changed. `state` is not modified.
 */
export function migrate(state) {
  const changes = [];
  const sessions = Array.isArray(state.editingSessions) ? state.editingSessions : [];
  const migrated = sessions.map((session) => {
    const next = { ...session };
    const name = `session ${session.id}`;
    if ("lastView" in next) {
      delete next.lastView;
      changes.push(`${name}: deleted lastView`);
    }
    for (const field of ["confirmed", "read", "impact"])
      if (!(field in next)) {
        next[field] = null;
        changes.push(`${name}: added ${field}: null`);
      }
    if (next.lastPane === "criteria") {
      next.lastPane = null;
      changes.push(`${name}: set lastPane "criteria" to null`);
    }
    if (next.change !== null && next.change !== undefined && !("by" in next.change)) {
      next.change = null;
      changes.push(`${name}: set a change that names no author to null`);
    }
    return next;
  });
  return { state: changes.length === 0 ? state : { ...state, editingSessions: migrated }, changes };
}

/**
 * Migrate the profile at `path`, writing the backup first. Returns the lines
 * printed; throws where the file cannot be read as JSON.
 */
export function run(path) {
  const file = profileFile(path);
  const state = JSON.parse(readFileSync(file, "utf8"));
  const { state: next, changes } = migrate(state);
  if (changes.length === 0) return [`${file}: nothing to change`];
  copyFileSync(file, `${file}.bak`);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return [`${file}: backed up to ${file}.bak`, ...changes];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, ...rest] = process.argv.slice(2);
  if (path === undefined || rest.length > 0) {
    console.error("usage: node scripts/migrate-workspace-round8.mjs <profile directory or its workspace.json>");
    process.exit(2);
  }
  try {
    for (const line of run(path)) console.log(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
