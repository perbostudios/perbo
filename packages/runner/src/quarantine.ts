import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * ADR-0030 requirement 2: withhold repository-supplied agent configuration from
 * the worktree, and restore it afterwards.
 *
 * This is the mechanism that survives a gap in requirement 1. Suppression flags
 * cover the paths the vendor documents; this covers the paths it does not, and
 * every path belonging to a convention this adapter has never heard of.
 *
 * The consequence ADR-0030 names is the one that matters here: the runner does
 * filesystem mutation around handover, and an interrupted attempt must not
 * leave a repository missing its configuration. So the journal is written
 * **before** anything moves, and `restoreAny` runs at startup.
 */

/**
 * Every convention this adapter knows about, plus the shapes of the ones it
 * does not. Matching is on path segments rather than globs because a directory
 * is moved whole.
 */
export const QUARANTINED_NAMES = [
  ".claude",
  ".mcp.json",
  ".cursor",
  ".cursorrules",
  ".windsurfrules",
  ".aider.conf.yml",
  ".aiderignore",
  ".agent",
  ".agents",
  ".codex",
  ".continue",
  ".github/copilot-instructions.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".clinerules",
  ".roo",
  ".roomodes",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
] as const;

const QuarantineEntrySchema = z.strictObject({
  /** Worktree-relative, so a moved worktree still restores correctly. */
  relative_path: z.string().min(1),
  stored_as: z.string().min(1),
  sha256: z.string().min(1),
  kind: z.enum(["file", "directory"]),
});

export const QuarantineJournalSchema = z.strictObject({
  attempt_id: z.string().min(1),
  worktree: z.string().min(1),
  store: z.string().min(1),
  created_at: z.iso.datetime(),
  entries: z.array(QuarantineEntrySchema),
});
export type QuarantineJournal = z.infer<typeof QuarantineJournalSchema>;

function hashOf(path: string): string {
  const hash = createHash("sha256");
  const walk = (target: string) => {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      for (const name of readdirSync(target).sort()) {
        hash.update(name);
        walk(join(target, name));
      }
      return;
    }
    hash.update(readFileSync(target));
  };
  walk(path);
  return hash.digest("hex");
}

/** Every quarantinable path present in the worktree, at any depth. */
export function findAgentConfiguration(worktree: string, maxDepth = 4): string[] {
  const root = resolve(worktree);
  const found: string[] = [];
  const names = new Set<string>(QUARANTINED_NAMES.filter((name) => !name.includes("/")));
  const nested: string[] = QUARANTINED_NAMES.filter((name) => name.includes("/"));

  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (names.has(entry.name)) {
        found.push(relative(root, full).split(sep).join("/"));
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 0);

  for (const name of nested) {
    const full = join(root, name);
    if (existsSync(full)) found.push(name);
  }
  return [...new Set(found)].sort();
}

/**
 * Move every agent-configuration path out of the worktree, journalling first.
 * Returns the journal, which the attempt records so the run bundle can say what
 * was withheld rather than only that something was.
 */
export function quarantine(args: {
  worktree: string;
  store: string;
  attempt_id: string;
  now?: Date;
}): QuarantineJournal {
  const worktree = resolve(args.worktree);
  const store = resolve(args.store, args.attempt_id);
  const paths = findAgentConfiguration(worktree);

  const journal: QuarantineJournal = {
    attempt_id: args.attempt_id,
    worktree,
    store,
    created_at: (args.now ?? new Date()).toISOString(),
    entries: paths.map((relativePath) => ({
      relative_path: relativePath,
      stored_as: relativePath.replace(/\//g, "__"),
      sha256: hashOf(join(worktree, relativePath)),
      kind: statSync(join(worktree, relativePath)).isDirectory()
        ? ("directory" as const)
        : ("file" as const),
    })),
  };

  mkdirSync(store, { recursive: true });
  // Written before the first move: a crash between here and the last rename
  // leaves a journal that `restoreAny` can act on.
  writeFileSync(journalPath(args.store, args.attempt_id), `${JSON.stringify(journal, null, 2)}\n`);

  for (const entry of journal.entries) {
    renameSync(join(worktree, entry.relative_path), join(store, entry.stored_as));
  }
  return journal;
}

export function journalPath(store: string, attemptId: string): string {
  return resolve(store, `${attemptId}.quarantine.json`);
}

export function restore(journal: QuarantineJournal): { restored: string[]; missing: string[] } {
  const restored: string[] = [];
  const missing: string[] = [];
  for (const entry of journal.entries) {
    const from = join(journal.store, entry.stored_as);
    const to = join(journal.worktree, entry.relative_path);
    if (!existsSync(from)) {
      missing.push(entry.relative_path);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
    restored.push(entry.relative_path);
  }
  return { restored, missing };
}

/**
 * Crash recovery. Run at startup: any journal still on disk describes a
 * worktree that is currently missing its configuration.
 */
export function restoreAny(store: string): Array<{ attempt_id: string; restored: string[] }> {
  if (!existsSync(store)) return [];
  const out: Array<{ attempt_id: string; restored: string[] }> = [];
  for (const name of readdirSync(store)) {
    if (!name.endsWith(".quarantine.json")) continue;
    let journal: QuarantineJournal;
    try {
      journal = QuarantineJournalSchema.parse(JSON.parse(readFileSync(join(store, name), "utf8")));
    } catch {
      continue;
    }
    if (!existsSync(journal.worktree)) {
      // The worktree is gone, so there is nothing to restore into. Drop the
      // journal rather than leaving it to be retried forever.
      rmSync(join(store, name), { force: true });
      continue;
    }
    const result = restore(journal);
    rmSync(join(store, name), { force: true });
    out.push({ attempt_id: journal.attempt_id, restored: result.restored });
  }
  return out;
}

export function release(journal: QuarantineJournal, store: string): void {
  restore(journal);
  rmSync(journalPath(store, journal.attempt_id), { force: true });
  rmSync(journal.store, { recursive: true, force: true });
}
