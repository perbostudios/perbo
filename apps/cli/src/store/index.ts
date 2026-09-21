import { readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_ADR_FOLDER,
  DEFAULT_SPEC_FOLDER,
  isRepositoryRelativeFolder,
  readStandingProhibited,
  type StandingProhibitedEntry,
} from "@perbo/contracts";
import { git } from "@perbo/workspace";

/**
 * The store directory itself: where it is, what it declares, and the error a
 * command raises when it cannot be read.
 *
 * Separate from `tickets.ts`, which is the ticket store *inside* it:
 * `<repo>/.perbo/` holds the run configuration, the attempts, the bundles and
 * the baseline — local working state of one machine, read regardless of
 * whether anything is admitted — while `<repo>/.perbo/tickets/` is admitted
 * history, read only by the commands that admit and track work. Nothing in
 * this file names a ticket file.
 */

/** `<repo>/.perbo`, unless a command was pointed somewhere else. */
export const DEFAULT_STORE_DIRNAME = ".perbo";

/**
 * Anything a command could not read out of the store, in the words a person can
 * act on. Exported from `tickets.ts` as `TicketStoreError` too: the two names
 * are one class, so a caller that catches either catches both.
 */
export class StoreError extends Error {}

export function storeDir(repositoryRoot: string, override?: string | null): string {
  return override ? resolve(override) : join(resolve(repositoryRoot), DEFAULT_STORE_DIRNAME);
}

/**
 * Which store a command works against: the repository it was pointed at, and
 * an explicit store inside or outside it.
 *
 * One field of every command's input, so a caller that has the two paths has
 * the whole of the answer to "where does this read and write" without
 * spelling `--repo` and `--store` again.
 *
 * Either path may be empty, and an empty one is not a missing one: `--repo ""`
 * is the directory the command was run in and `--store ""` is the store that
 * directory holds, which is where the command works with neither flag given.
 * `perbo list --repo "$REPO"` with `REPO` unset therefore lists the store it
 * is standing in rather than refusing a line it can act on.
 */
export const StoreTargetSchema = z.strictObject({
  repo: z.string(),
  store: z.string().nullable(),
});
export type StoreTarget = z.infer<typeof StoreTargetSchema>;

/** The store a target names, from the directory the command was run in. */
export const storeFor = (cwd: string, target: StoreTarget): string =>
  storeDir(resolve(cwd, target.repo), target.store);

/**
 * What a record in the store says about where the repository is, when it says
 * nothing: the store's own parent, which for `<repo>/.perbo` is `<repo>`.
 *
 * A default rather than a required field, because it is right for every store
 * that has not been moved out of its repository, and because it is what a
 * record written before repository roots were relative has to be read as — the
 * absolute path such a record carries is a fact about the machine that wrote
 * it, so the only honest reading of it is none at all.
 */
export const DEFAULT_REPOSITORY_ROOT = "..";

/**
 * The repository a store belongs to: the inverse of {@link storeDir}.
 *
 * `stored` is the relative path a record carries, or `undefined` for one that
 * carries none. Everything is resolved against `dir` — the store the record was
 * actually read out of — so a ticket cloned to a second machine, copied into a
 * worktree or read out of CI names *that* checkout, and `run`, `sync` and the
 * worktrees they provision act on the tree the person is looking at.
 */
export function repositoryRootOf(dir: string, stored?: string | null): string {
  return resolve(dir, stored === null || stored === undefined ? DEFAULT_REPOSITORY_ROOT : stored);
}

/**
 * The same fact on the way out: where the repository is, written so that any
 * clone can read it. The inverse of {@link repositoryRootOf}, and what every
 * record this store writes puts in its `repository_root`.
 *
 * `.` where the two are the same directory, because `relative` says that with
 * an empty string and a record's path field has to name something. The one case
 * with no relative answer is a store on a different Windows drive from its
 * repository, where `relative` returns an absolute path: there is no path from
 * one root to the other, so the absolute one is the only true thing left to
 * write, and it is as portable as that arrangement can be.
 */
export function storedRepositoryRoot(dir: string, repositoryRoot: string): string {
  return relative(resolve(dir), resolve(repositoryRoot)) || ".";
}

/**
 * The checkout the store belongs to, as a run needs to name it: the commit a
 * plan is captured against, and the id its scope is keyed by.
 *
 * Here rather than in `tickets.ts` because neither answer comes from a ticket.
 * `perbo run` mints a contract against this checkout's HEAD with nothing
 * admitted behind it (SCP-180), so a run with no ticket has no store to read
 * them from; `tickets.ts` re-exports both under the names its callers use.
 *
 * Both go through `@perbo/workspace`'s repository module, which is where every
 * git process Perbo starts is decided: argv only, the runner's environment
 * rather than this one's, a bounded wait, and a listing too large to hold
 * refused rather than handed back cut.
 */
/** What a tracked listing of this repository is allowed to be. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

export function headCommit(repositoryRoot: string): string {
  let head: string | null;
  try {
    head = git.headSync(repositoryRoot);
  } catch (error) {
    throw new StoreError(
      `cannot read HEAD in ${repositoryRoot}: ${
        error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error)
      }`,
      { cause: error },
    );
  }
  if (head === null) {
    throw new StoreError(
      `cannot read HEAD in ${repositoryRoot}: git named no commit there, so it is either not a ` +
        "repository or has nothing committed yet",
    );
  }
  return head;
}

/**
 * Every tracked file in the repository, repository-relative, or an empty list
 * where git cannot say.
 *
 * What a plan's size counts over (D-104). Tracked rather than walked, so a
 * build directory or an uncommitted scratch file cannot change a plan's size;
 * empty rather than thrown, because a size is a reading beside the plan and a
 * checkout git will not answer for is not a reason to refuse `inspect`.
 */
export function trackedFiles(repositoryRoot: string): string[] {
  try {
    return git.trackedFilesSync(repositoryRoot, { maxOutputBytes: MAX_LISTING_BYTES });
  } catch {
    return [];
  }
}

/** `repo_` plus the directory name, lowercased to what the id pattern allows. */
export function repositoryId(repositoryRoot: string): string {
  const name = basename(resolve(repositoryRoot)).replace(/[^0-9A-Za-z_-]/g, "-");
  return `repo_${name || "repository"}`;
}

/** The `<store>/config.json` keys a repository declares judging paths under. */
export const JUDGING_CONFIG_KEYS = ["protected_paths", "protected_tests"] as const;

/** One key of `<store>/config.json`, or undefined where the file or the key is absent. */
function configValue(dir: string, key: string): unknown {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StoreError(
        `${join(dir, "config.json")} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return raw === null || typeof raw !== "object" ? undefined : raw[key];
}

/** The `<store>/config.json` key naming where this repository keeps its specs (D-103). */
export const SPEC_FOLDER_CONFIG_KEY = "specs";

/** The `<store>/config.json` key naming where this repository keeps its ADRs (D-103). */
export const ADR_FOLDER_CONFIG_KEY = "adr";

/**
 * The repository-relative folder a repository keeps its specs in: `specs`
 * unless `config.json` names another under `specs` (D-103).
 *
 * Read here rather than from the run configuration because two things want it
 * before any run exists — where a new spec's folder is created, and which
 * paths a contract puts off limits to the executor.
 */
export function specFolder(dir: string): string {
  return configuredFolder(dir, SPEC_FOLDER_CONFIG_KEY, DEFAULT_SPEC_FOLDER, "specs live", '"specs" or "docs/specs"');
}

/**
 * The repository-relative folder a repository keeps its ADRs in: `docs/adr`
 * unless `config.json` names another under `adr` (D-102, D-103).
 *
 * Read beside {@link specFolder}, because two things want both: the interview
 * writes the spec folder, `CONTEXT.md` and this, and a spec's admission records
 * the ADRs changed with it for the loop to commit on the ticket's branch.
 */
export function adrFolder(dir: string): string {
  return configuredFolder(dir, ADR_FOLDER_CONFIG_KEY, DEFAULT_ADR_FOLDER, "ADRs live", '"docs/adr" or "adr"');
}

/** One `config.json` key naming a repository-relative folder, or its default. */
function configuredFolder(
  dir: string,
  key: string,
  fallback: string,
  what: string,
  example: string,
): string {
  const named = configValue(dir, key);
  if (named === undefined) return fallback;
  if (typeof named !== "string" || !isRepositoryRelativeFolder(named)) {
    throw new StoreError(
      `${join(dir, "config.json")} sets '${key}' to something that is not a ` +
        `repository-relative folder. It names where ${what}, for example ${example}`,
    );
  }
  return named;
}

/**
 * A path a check pins as its definition, named with the checks that pin it:
 * `checks[check_docs].definition_path`. The check is in the source because it
 * is the answer to "why is this file protected" — the path alone says a file
 * is out of scope, the check says which check the attempt would be editing.
 */
export type CheckDefinitionSource = `checks[${string}].definition_path`;

/** Where one judging path came from: the store itself, or the key that listed it. */
export type JudgingSource = "store" | (typeof JUDGING_CONFIG_KEYS)[number] | CheckDefinitionSource;

export interface JudgingPath {
  /**
   * The glob that judges an attempt, or `null` for a config key that supplies
   * none — so a reader is told about a key that is silent instead of having to
   * infer it from an absence.
   */
  path: string | null;
  source: JudgingSource;
  /** `false` when `source` is a config key the store does not set at all. */
  set: boolean;
}

/**
 * Every path a check pins as its definition, in the order the checks are
 * declared, each against the checks that pin it. The runner seals a write to
 * one as `modify_judging_artifact` — it derives them the same way, from
 * `checks[].definition_path` — so approval refuses a scope that reaches one.
 *
 * Two checks pinning one file (`turbo.json` for typecheck and unit here) is one
 * entry naming both, so a refusal names every check the scope would reach
 * rather than whichever was declared first. A check with no usable `check_id`
 * still pins its path, and is named by its position in the list, which is what
 * a reader has to find it in the file by.
 */
function checkDefinitionOwners(raw: Record<string, unknown> | null): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const checks = raw === null ? undefined : raw["checks"];
  if (!Array.isArray(checks)) return owners;
  checks.forEach((check, index) => {
    if (check === null || typeof check !== "object") return;
    const entry = check as Record<string, unknown>;
    const path = entry["definition_path"];
    if (typeof path !== "string" || path === "") return;
    const id = entry["check_id"];
    const owner = typeof id === "string" && id !== "" ? id : `#${index}`;
    const named = owners.get(path);
    if (named === undefined) owners.set(path, [owner]);
    else if (!named.includes(owner)) named.push(owner);
  });
  return owners;
}

/**
 * What this repository declares as judging an attempt (D-045), each path with
 * the key it came from: the review policy paths and protected tests in
 * `<store>/config.json`, the definition each pinned check is run from, plus the
 * store itself, which the runner refuses every write to. Read at approval so a
 * scope that overlaps them is refused with the reason rather than discovered at
 * the seal, after an attempt has been paid for, and reported by `perbo doctor`
 * so the list can be read before a scope is written against it.
 *
 * A config key contributing nothing is still an entry, with a `null` path:
 * unset when the store has no `config.json` or does not name the key, and
 * set-but-silent when it names one that lists no path this store does not
 * already judge. `checks` has no such entry: a check pins a definition or it
 * does not, and a store that pins none is judging by nothing it has left
 * undeclared.
 */
export function judgingPaths(dir: string): JudgingPath[] {
  const entries: JudgingPath[] = [{ path: ".perbo/**", source: "store", set: true }];
  const seen = new Set(entries.map((entry) => entry.path));
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StoreError(
        `${join(dir, "config.json")} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const source of JUDGING_CONFIG_KEYS) {
    const value = raw === null || typeof raw !== "object" ? undefined : raw[source];
    const set = value !== undefined;
    // A key holding something other than a list of strings judges nothing, the
    // same as one holding an empty list: it is set, and it is silent.
    const listed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const before = entries.length;
    for (const path of listed) {
      if (seen.has(path)) continue;
      seen.add(path);
      entries.push({ path, source, set });
    }
    if (entries.length === before) entries.push({ path: null, source, set });
  }
  for (const [path, owners] of checkDefinitionOwners(raw)) {
    if (seen.has(path)) continue;
    seen.add(path);
    // Comma with no space: the source is a column in `doctor`'s block and a
    // field a script splits, and whitespace inside it would break both.
    entries.push({ path, source: `checks[${owners.join(",")}].definition_path`, set: true });
  }
  return entries;
}

/**
 * What this repository prohibits a write to for every ticket (D-105), each
 * entry with what put it there. Admission folds them into a new ticket's
 * `paths_prohibited`, and the runner's guard reads the same key again at run
 * time, so an entry added after a ticket was admitted still holds for its runs.
 *
 * Not a judging path: an approved scope may name a path this prohibits. What is
 * refused is the write.
 */
export function standingProhibited(dir: string): StandingProhibitedEntry[] {
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StoreError(
        `${join(dir, "config.json")} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return readStandingProhibited(raw);
}

/** One judging path with the key that judges by it. */
export interface JudgingRule {
  path: string;
  source: JudgingSource;
}

/**
 * The judging paths that name a place — what an approved scope is checked for
 * overlap against, each still carrying its source so a refusal can say which
 * check or which key the scope reached.
 */
export function readJudgingPaths(dir: string): JudgingRule[] {
  return judgingPaths(dir).flatMap((entry) =>
    entry.path === null ? [] : [{ path: entry.path, source: entry.source }],
  );
}
