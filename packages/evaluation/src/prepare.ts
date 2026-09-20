import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git as defaultGit, type Git, type RunResult } from "@perbo/workspace";
import type { LoadedFixture } from "./corpus.js";
import type { PinnedRepository } from "./fixture.js";

/**
 * Materialise a pinned-repository fixture into a cache (`perbo-corpus prepare`).
 *
 * The cache is never checked in. That is not tidiness: it is what keeps upstream
 * code out of this repository entirely, so the corpus's "no upstream code is
 * copied" rule holds for these fixtures by construction rather than by review.
 *
 * Only permissive licences are cloned. A copyleft repository would be fine to
 * *read* but the reviewer's artifacts quote code, and an artifact is a
 * derivative work nobody has thought about; the reconstruction rule exists for
 * exactly that reason and this is the same rule applied one level up.
 */

export const PERMISSIVE_LICENCES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"] as const;

export class UnacceptableLicenceError extends Error {
  constructor(fixtureId: string, licence: string) {
    super(
      `${fixtureId} pins a repository licensed ${licence}; the corpus clones only ` +
        `${PERMISSIVE_LICENCES.join(", ")}`,
    );
    this.name = "UnacceptableLicenceError";
  }
}

export interface PreparedFixture {
  fixture_id: string;
  repo_dir: string;
  diff_path: string;
  clone_ms: number;
  diff_bytes: number;
  files_changed: number;
}

export function cachePathFor(cacheRoot: string, fixtureId: string): string {
  return resolve(cacheRoot, fixtureId);
}

/**
 * One clone per repository, shared by every fixture that pins it.
 *
 * Three fixtures pinning the same repository as three independent clones cost
 * 1.4 GB, so twenty would not fit on the laptop this runs on (D-049 again, one
 * layer out). A worktree off a shared clone costs one checkout and no objects.
 */
export function clonePathFor(cacheRoot: string, url: string): string {
  const slug = url
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-");
  return resolve(cacheRoot, "clones", slug);
}

/** How long a git call inside a clone this size may take. */
const LOCAL_TIMEOUT_MS = 600_000;
/** How long the clone itself may take. These repositories are hundreds of MB. */
const CLONE_TIMEOUT_MS = 900_000;
/** What a diff between two pinned commits may be, past which only part arrives. */
const MAX_DIFF_BYTES = 32 * 1024 * 1024;

const CALL = { timeoutMs: LOCAL_TIMEOUT_MS, maxOutputBytes: MAX_DIFF_BYTES } as const;

/**
 * Refuse an answer only part of which arrived.
 *
 * Past the ceiling only the tail is kept, and the flag is the only thing that
 * says so: a diff cut that way is still a valid-looking diff, and a fixture
 * prepared from one pins a `change.diff` that is not the change the reviewer is
 * scored on. So the size is the answer here rather than the bytes that fit.
 */
function refuseCut(result: RunResult, fixtureId: string, what: string): void {
  if (result.truncated) {
    throw new Error(
      `${fixtureId}: the ${what} is larger than ${MAX_DIFF_BYTES} bytes and only part of it arrived`,
    );
  }
}

/**
 * Clone at the pinned commits, check out the head, and write the diff.
 *
 * Idempotent: an existing cache with the right head is reused, so a corpus run
 * after a prepare costs nothing and a re-prepare after a fixture edit is cheap.
 */
export async function prepareFixture(args: {
  fixture: LoadedFixture;
  cacheRoot: string;
  onProgress?: (message: string) => void;
  /** The repository module every git call here goes through. */
  git?: Git;
}): Promise<PreparedFixture> {
  const git = args.git ?? defaultGit;
  const pinned: PinnedRepository | null = args.fixture.fixture.pinned_repository;
  if (!pinned) throw new Error(`${args.fixture.fixture.id} pins no repository`);
  if (!(PERMISSIVE_LICENCES as readonly string[]).includes(pinned.licence)) {
    throw new UnacceptableLicenceError(args.fixture.fixture.id, pinned.licence);
  }
  const progress = args.onProgress ?? (() => undefined);
  const dir = cachePathFor(args.cacheRoot, args.fixture.fixture.id);
  const repo = join(dir, "repo");
  const diffPath = join(dir, "change.diff");
  mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const clone = clonePathFor(args.cacheRoot, pinned.url);
  if (!existsSync(join(clone, ".git"))) {
    progress(`clone ${pinned.url}`);
    mkdirSync(clone, { recursive: true });
    const cloned = await git.clone(resolve(clone, ".."), pinned.url, clone, {
      noTags: true,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (cloned.code !== 0) {
      throw new Error(`clone failed for ${args.fixture.fixture.id}: ${cloned.stderr.trim().slice(-400)}`);
    }
  }

  // A fixture prepared before shared clones existed has its own clone here. It
  // is a valid checkout, and re-cloning to tidy the layout would cost more than
  // it saves.
  if (!existsSync(join(repo, ".git"))) {
    progress(`worktree at ${pinned.head_commit.slice(0, 12)}`);
    const added = await git.addWorktree(
      clone,
      { path: repo, detach: pinned.head_commit, force: true },
      CALL,
    );
    if (added.code !== 0) {
      throw new Error(
        `${args.fixture.fixture.id}: ${pinned.head_commit} is not in ${pinned.url} — ` +
          "a pinned commit that has been rewritten away is a broken fixture, not a missing clone",
      );
    }
  }

  const head = await git.head(repo, CALL);
  if (head !== pinned.head_commit) {
    progress(`checkout ${pinned.head_commit.slice(0, 12)}`);
    const checkout = await git.run(repo, ["checkout", "--detach", "--force", pinned.head_commit], CALL);
    if (checkout.code !== 0) {
      throw new Error(`${args.fixture.fixture.id}: could not check out ${pinned.head_commit}`);
    }
  }

  const range = `${pinned.base_commit}..${pinned.head_commit}`;
  const diff = await git.run(repo, ["diff", "--no-color", range], CALL);
  if (diff.code !== 0) {
    throw new Error(`${args.fixture.fixture.id}: could not diff the pinned commits`);
  }
  refuseCut(diff, args.fixture.fixture.id, "diff between the pinned commits");
  writeFileSync(diffPath, diff.stdout);

  const names = await git.run(repo, ["diff", "--name-only", range], CALL);
  refuseCut(names, args.fixture.fixture.id, "list of files changed between the pinned commits");

  return {
    fixture_id: args.fixture.fixture.id,
    repo_dir: repo,
    diff_path: diffPath,
    clone_ms: Date.now() - started,
    diff_bytes: Buffer.byteLength(diff.stdout, "utf8"),
    files_changed: names.stdout.split("\n").filter((line) => line.trim().length > 0).length,
  };
}

export function renderPrepared(prepared: readonly PreparedFixture[]): string {
  const lines = ["| Fixture | files changed | diff | prepared in |", "|---|---|---|---|"];
  for (const entry of prepared) {
    lines.push(
      `| \`${entry.fixture_id}\` | ${entry.files_changed} | ${(entry.diff_bytes / 1024).toFixed(1)} KiB | ` +
        `${(entry.clone_ms / 1000).toFixed(1)}s |`,
    );
  }
  return lines.join("\n");
}
