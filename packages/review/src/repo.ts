import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AGENT_CONFIG_PATTERNS, NEVER_READ_PATHS, isAgentConfigPath, matchesAny } from "@perbo/contracts";
import { nulByteOffset } from "./legibility.js";

/**
 * The repository surface the reviewer selects files from.
 *
 * "Independently selected files" is the independence property that costs
 * something to implement: the reviewer has to be able to open a file the diff
 * never touched, which is how a missing call in an unchanged module becomes
 * visible. Everything here is read-only and bounded.
 */

export interface RepoLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
  maxTreeEntries: number;
}

export const DEFAULT_REPO_LIMITS: RepoLimits = {
  maxFiles: 25,
  maxBytesPerFile: 64 * 1024,
  maxTotalBytes: 400 * 1024,
  maxTreeEntries: 600,
};

/** Machine-local/generated directories that must not consume the bounded tree. */
const SKIP_DIRS = new Set([
  ".git",
  ".hypothesis",
  ".pytest_cache",
  ".yarn",
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  "coverage",
]);

/** Git worktrees and submodules use a `.git` marker file instead of a directory. */
const LOCAL_METADATA = ["**/.git", "**/.git/**"] as const;

/**
 * The materialized-secret half of {@link NEVER_READ_PATHS}: what this reader
 * refuses with its own sentence, because the refusal a reviewer reads has to
 * say which rule withheld the file. Git metadata and agent configuration carry
 * their own sentences below, and the three together are that list.
 */
const NEVER_READ = NEVER_READ_PATHS.filter(
  (pattern) =>
    !(LOCAL_METADATA as readonly string[]).includes(pattern) &&
    !(AGENT_CONFIG_PATTERNS as readonly string[]).includes(pattern),
);

export type ReadOutcome =
  | { ok: true; path: string; content: string; truncated: boolean; bytes: number; sha256: string }
  | {
      ok: false;
      path: string;
      refusal: string;
      /** Set when the file was refused for carrying a NUL byte (SCP-188). */
      illegible?: { reason: "nul_byte"; offset: number };
    };

export interface FileEntry {
  path: string;
  bytes: number;
}

export class RepoReader {
  readonly root: string;
  private readonly limits: RepoLimits;
  private readonly reads = new Map<string, ReadOutcome>();
  private totalBytes = 0;

  constructor(root: string, limits: RepoLimits = DEFAULT_REPO_LIMITS) {
    this.root = realpathSync(resolve(root));
    this.limits = limits;
  }

  /**
   * A flat listing, so the reviewer can choose. Agent-configuration files are
   * listed but never readable: hiding them would stop the reviewer reporting
   * that a change ships a hook, and reading them would be the channel ADR-0030
   * closes.
   */
  tree(): FileEntry[] {
    const out: FileEntry[] = [];
    const walk = (dir: string) => {
      if (out.length >= this.limits.maxTreeEntries) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= this.limits.maxTreeEntries) return;
        // `.git` can be a directory in a checkout or a machine-specific marker
        // file in a worktree/submodule. Neither is repository content.
        if (entry.name === ".git") continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const full = join(dir, entry.name);
        let bytes: number;
        try {
          bytes = statSync(full).size;
        } catch {
          continue;
        }
        out.push({ path: relative(this.root, full).split(sep).join("/"), bytes });
      }
    };
    walk(this.root);
    return out;
  }

  filesRead(): ReadOutcome[] {
    return [...this.reads.values()];
  }

  read(requested: string): ReadOutcome {
    const cached = this.reads.get(requested);
    if (cached) return cached;

    const outcome = this.readUncached(requested);
    this.reads.set(requested, outcome);
    if (outcome.ok) this.totalBytes += outcome.bytes;
    return outcome;
  }

  private refuse(
    path: string,
    refusal: string,
    illegible?: { reason: "nul_byte"; offset: number },
  ): ReadOutcome {
    return { ok: false, path, refusal, ...(illegible ? { illegible } : {}) };
  }

  private readUncached(requested: string): ReadOutcome {
    const normalised = requested.replace(/^\.\//, "").split(sep).join("/");

    if (this.reads.size >= this.limits.maxFiles) {
      return this.refuse(normalised, `file budget of ${this.limits.maxFiles} files is exhausted`);
    }
    if (this.totalBytes >= this.limits.maxTotalBytes) {
      return this.refuse(normalised, "total read budget is exhausted");
    }
    if (matchesAny(normalised, NEVER_READ)) {
      return this.refuse(
        normalised,
        "refused: this path may hold a materialized local secret, which never enters a model " +
          "context. Its existence is reportable; its contents are not readable.",
      );
    }
    if (matchesAny(normalised, LOCAL_METADATA)) {
      return this.refuse(
        normalised,
        "refused: Git metadata is machine-local and never enters reviewer context",
      );
    }
    if (isAgentConfigPath(normalised)) {
      return this.refuse(
        normalised,
        "refused: repository-supplied agent configuration is withheld rather than interpreted " +
          "(ADR-0030). That a change modifies it is reportable; its contents are not readable.",
      );
    }

    const target = resolve(this.root, normalised);
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return this.refuse(normalised, "no such file in the repository");
    }
    // realpath first, then the prefix test, so a symlink cannot walk out.
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      return this.refuse(normalised, "refused: path resolves outside the repository root");
    }

    let stat;
    try {
      stat = statSync(real);
    } catch {
      return this.refuse(normalised, "no such file in the repository");
    }
    if (stat.isDirectory()) {
      return this.refuse(normalised, "that is a directory; the tree listing already names its files");
    }

    const raw = readFileSync(real);
    // A file holding a NUL byte is not text. Git renders it as "Binary files …
    // differ", so the change set never showed it; decoding it and handing it on
    // puts that byte in the model's context, which once killed a whole review
    // at the transport (SCP-188). The refusal says where the byte is, which is
    // what makes it a fixable finding rather than a mystery.
    const nul = nulByteOffset(raw);
    if (nul !== -1) {
      return this.refuse(
        normalised,
        `refused: this file contains a NUL byte (U+0000) at byte ${nul}, so it is not text a ` +
          `reviewer can read. Git classifies any file holding one as binary and will not render ` +
          `its diff. That the file is unreadable is reportable; its contents are not readable.`,
        { reason: "nul_byte", offset: nul },
      );
    }
    const truncated = raw.length > this.limits.maxBytesPerFile;
    const slice = truncated ? raw.subarray(0, this.limits.maxBytesPerFile) : raw;
    return {
      ok: true,
      path: normalised,
      content: slice.toString("utf8"),
      truncated,
      bytes: slice.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  }
}
