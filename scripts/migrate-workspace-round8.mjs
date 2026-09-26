// Brings a desktop profile's `workspace.json` up to the records the desktop
// reads (D-130, D-NEW-basic-and-epic-flows, D-128): a profile written without
// these fields gains them. A profile that fails the schema stops Perbo from
// starting, so this runs before the first start of a build that reads them.
// It:
//
// - adds `lastOpened` as `{}` where the profile has none;
// - for every editing session:
//   - deletes `lastView`, which the contract tab's `confirmed` replaces;
//   - deletes `specCut`, a field the desktop does not read (D-118);
//   - adds `confirmed`, `read`, `impact` and `named` as null where the session
//     has none;
//   - sets a `lastPane` of "criteria", a pane planning does not have, to null,
//     so the planning reopens where it otherwise lands;
//   - sets a recorded `change` that does not say who made it to null, since the
//     panes mark only a change the chat made and this one cannot say;
//   - deletes `offers` from each note in its conversation, which a note does
//     not carry.
//
// The file is copied to `workspace.json.bak` before it is written, and each
// change is printed. A profile that needs nothing is left as it is, with no
// backup, so a second run changes nothing. An existing backup is never
// replaced: where one is there and the profile still needs changing, nothing
// is written and the run says so. A file that is not a profile's JSON — one
// whose `version` is not 1, or that has no `settings` object or no
// `repositories` list — is refused, and left as it is; so is a missing file,
// reported as missing.
//
// Quit Perbo first, since it writes the file as it closes. On macOS the
// profile is `~/Library/Application Support/Perbo/workspace.json`, the
// desktop's data directory (`app.getPath("appData")` joined with "Perbo" in
// `apps/desktop/src/host/main.ts`). From the repository root:
//
//   node scripts/migrate-workspace-round8.mjs ~/Library/Application\ Support/Perbo
//
// The argument is the profile directory or its `workspace.json`. Exit codes:
// 0 migrated or nothing to change, 1 refused, 2 a bad command line.

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the profile's record is: the file named, or `workspace.json` in the directory named. */
export function profileFile(path) {
  const named = resolve(path);
  return existsSync(named) && statSync(named).isDirectory() ? join(named, "workspace.json") : named;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** A conversation with `offers` taken off each note, and one line for each note it was taken from. */
function withoutOffers(conversation, name, changes) {
  let changed = false;
  const next = conversation.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.line) || entry.line.kind !== "note" || !("offers" in entry.line))
      return entry;
    const { offers: _offers, ...line } = entry.line;
    changed = true;
    changes.push(`${name}: deleted offers from conversation entry ${entry.n}`);
    return { ...entry, line };
  });
  return changed ? next : conversation;
}

/**
 * The profile's state brought up to the records, and one line for each thing
 * changed. `state` is not modified. Throws where `state` is not a profile.
 */
export function migrate(state) {
  if (!isRecord(state)) throw new Error("it holds no profile: its top level is not an object");
  // What makes it a profile, as the desktop's ProfileStateSchema requires
  // (`apps/desktop/src/host/profile/store.ts`): anything else is not one.
  if (state.version !== 1) throw new Error("it holds no profile: its version is not 1");
  if (!isRecord(state.settings)) throw new Error("it holds no profile: its settings is not an object");
  if (!Array.isArray(state.repositories)) throw new Error("it holds no profile: its repositories is not a list");
  if (state.editingSessions !== undefined && !Array.isArray(state.editingSessions))
    throw new Error("it holds no profile: its editingSessions is not a list");
  const changes = [];
  const next = { ...state };
  if (!("lastOpened" in next)) {
    next.lastOpened = {};
    changes.push("profile: added lastOpened: {}");
  }
  if (state.editingSessions !== undefined)
    next.editingSessions = state.editingSessions.map((session, index) => {
      if (!isRecord(session)) throw new Error(`it holds no profile: editing session ${index} is not an object`);
      const migrated = { ...session };
      const name = `session ${session.id}`;
      for (const field of ["lastView", "specCut"])
        if (field in migrated) {
          delete migrated[field];
          changes.push(`${name}: deleted ${field}`);
        }
      for (const field of ["confirmed", "read", "impact", "named"])
        if (!(field in migrated)) {
          migrated[field] = null;
          changes.push(`${name}: added ${field}: null`);
        }
      if (migrated.lastPane === "criteria") {
        migrated.lastPane = null;
        changes.push(`${name}: set lastPane "criteria" to null`);
      }
      if (isRecord(migrated.change) && !("by" in migrated.change)) {
        migrated.change = null;
        changes.push(`${name}: set a change that names no author to null`);
      }
      if (Array.isArray(migrated.conversation))
        migrated.conversation = withoutOffers(migrated.conversation, name, changes);
      return migrated;
    });
  return { state: changes.length === 0 ? state : next, changes };
}

/**
 * Migrate the profile at `path`, writing the backup first. Returns the lines
 * printed; throws, having written nothing, where the file cannot be read as a
 * profile or a backup is already there.
 */
export function run(path) {
  const file = profileFile(path);
  if (!existsSync(file)) throw new Error(`${file} is missing, so nothing was changed.`);
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file} could not be read as JSON, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let migrated;
  try {
    migrated = migrate(state);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}, so nothing was changed.`);
  }
  const { state: next, changes } = migrated;
  if (changes.length === 0) return [`${file}: nothing to change`];
  const backup = `${file}.bak`;
  if (existsSync(backup))
    throw new Error(
      `${file}: ${backup} is already there, and a backup is never replaced, so nothing was changed. ` +
        "Move it aside and run this again.",
    );
  copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return [`${file}: backed up to ${backup}`, ...changes];
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
