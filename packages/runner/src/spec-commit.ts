import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { SpecFile } from "@perbo/contracts";
import { git } from "@perbo/workspace";
import { RunRefusedError } from "./refusal.js";

/**
 * The spec the change is judged against, committed first on the ticket's
 * branch (D-103).
 *
 * The branch carries the spec because the spec lands with the change: a person
 * reading the pull request reads the intent and the work in one place, and the
 * `CONTEXT.md` and ADR changes the interview made travel with them. The review
 * does not read it, which is the other half — `spec_paths` in the seal keeps
 * every file this commit holds out of the change set, whichever round it is.
 *
 * Three properties hold here rather than being hoped for.
 *
 * 1. **It is the branch's first commit past the contract's base**, made before
 *    the executor is invoked and before the base is merged up, so every later
 *    step measures a branch whose spec is already below it.
 * 2. **It holds exactly what approval recorded.** The bytes come out of the
 *    primary checkout and each file's SHA-256 is checked against the record
 *    first: a spec edited since approval stops the run rather than being
 *    committed as the statement the contract was drafted from, and nothing the
 *    executor could have written is in the commit, because the executor has
 *    not run.
 * 3. **It carries the loop's `Attempt:` trailer**, so a re-level reading the
 *    branch for commits the loop did not make (SCP-227) reads this as its own.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What a listing of the branch may say, past which only its tail arrives.
 *
 * The commits past the base and the message of the first one are read to decide
 * whether the branch's spec is where the record says, so a cut answer is one
 * this would act on as if it were complete.
 */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** What a run did about the spec commit, and the commit where there is one. */
export interface SpecCommitResult {
  /** The commit the branch's spec sits in, or null where the branch has none. */
  commit: string | null;
  /** The repository-relative files that commit holds, which the seal excludes. */
  paths: string[];
}

/**
 * Whether a path is one file inside the repository: relative, with no `..`
 * segment and nothing under `.git`.
 *
 * The paths come from the admission record rather than from a model, and this
 * is the belt beside that brace: a record written by hand, or carried over
 * from another checkout, must not make the loop write outside the worktree.
 */
function isRepositoryRelativeFile(path: string): boolean {
  if (path.length === 0 || path.trim() !== path) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  return segments[0] !== ".git";
}

/**
 * The nearest folder of `folder` that exists, resolved.
 *
 * A recorded file's folder need not be in the worktree yet, and where making
 * it would land is what the folders above it say: a link anywhere on the way
 * has to be judged before `mkdirSync` follows it and puts a directory outside
 * the worktree.
 */
function nearestExisting(folder: string): string {
  let at = folder;
  for (;;) {
    try {
      return realpathSync(at);
    } catch {
      const up = dirname(at);
      if (up === at) return at;
      at = up;
    }
  }
}

const sha256 = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function refuse(message: string, repository_root: string): never {
  throw new RunRefusedError({ message, findings: [], repository_root });
}

/**
 * Put the recorded spec on the branch, or confirm that the branch already
 * carries it.
 *
 * Returns the commit and the paths the seal excludes for it. `commit` is null
 * in three cases: a ticket admitted without a spec, which has no paths either
 * and nothing to say about them; a branch whose base
 * already holds every recorded file; and a branch that already had commits
 * when no run had recorded a spec commit for it — a ticket admitted before the
 * loop committed one — and each of those two says on progress which it is. They
 * return the paths, because the seal excludes
 * them whether this run made the commit or the branch already carried the
 * files: a branch built before the loop committed specs may hold a hand edit
 * to `CONTEXT.md` or an ADR, and reading that as work would report the change
 * set as reaching outside the contract's globs — a write the guard never saw,
 * because no executor made it.
 */
export async function commitSpec(args: {
  worktree: string;
  /** The checkout the recorded bytes are read from. */
  repository_root: string;
  /** The contract's base: what "first commit on the branch" is measured from. */
  base_commit: string;
  ticket_key: string;
  /** For the commit's trailer. Nothing the agent wrote reaches the message. */
  attempt_id: string;
  files: readonly SpecFile[];
  /** The spec commit this ticket's attempts record names, or null where none does. */
  recorded: string | null;
  onProgress?: (message: string) => void;
  timeoutMs?: number;
}): Promise<SpecCommitResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const progress = args.onProgress ?? (() => undefined);
  if (args.files.length === 0) return { commit: null, paths: [] };

  const paths = args.files.map((file) => file.path);
  const outside = paths.filter((path) => !isRepositoryRelativeFile(path));
  if (outside.length > 0) {
    refuse(
      `${args.ticket_key}'s admission record names ${outside.join(", ")} as a spec file, which is ` +
        "not a file inside the repository; the loop commits the spec it was drafted from and " +
        "nothing outside the checkout",
      args.repository_root,
    );
  }

  const onBranch = await firstParentCommits(args.worktree, args.base_commit, timeoutMs);
  if (onBranch.length > 0) {
    return confirmOnBranch({ ...args, paths, first: onBranch[0]!, progress, timeoutMs });
  }

  // The bytes, checked before anything is written: a file the checkout no
  // longer has, or one whose content has moved since approval, stops the run
  // here — where no worktree has been materialized and no executor invoked.
  const bytes = new Map<string, Buffer>();
  const checkout = realpathSync(args.repository_root);
  for (const file of args.files) {
    const source = resolve(args.repository_root, file.path);
    let content: Buffer;
    try {
      content = readFileSync(source);
    } catch {
      refuse(
        `${file.path} is on ${args.ticket_key}'s admission record and ${args.repository_root} does ` +
          "not have it. The spec is what the change is judged against, so the run stops rather " +
          "than committing a spec that is not the one the contract was drafted from",
        args.repository_root,
      );
    }
    // Where the bytes come from, not where the path spells it: a folder on the
    // way that is a link makes a repository-relative path read a file the
    // checkout does not hold, and the hash recorded over that same path agrees.
    const from = realpathSync(source);
    if (!from.startsWith(checkout + sep)) {
      refuse(
        `${file.path} is on ${args.ticket_key}'s admission record and ${args.repository_root} ` +
          `reads it from ${from}, outside the checkout. The loop commits the spec it was drafted ` +
          "from and nothing outside the checkout",
        args.repository_root,
      );
    }
    const found = sha256(content);
    if (found !== file.content_sha256) {
      refuse(
        `${file.path} has changed since ${args.ticket_key} was approved: the record has ` +
          `${file.content_sha256} and ${args.repository_root} has ${found}. The spec is what the ` +
          "change is judged against, so the run stops rather than committing a spec that is not " +
          "the one the contract was drafted from",
        args.repository_root,
      );
    }
    bytes.set(file.path, content);
  }

  // Every target is judged before any is written, so a record one file of
  // which cannot be written leaves the worktree as it was found.
  const inside = realpathSync(args.worktree);
  for (const path of bytes.keys()) {
    const target = join(args.worktree, path);
    // Where the write lands, not where the path spells it. A recorded path is
    // repository-relative and says nothing about a folder that is a symlink in
    // the worktree, and the lexical check above cannot see one. The nearest
    // folder that exists is what resolves: the ones below it are not there
    // yet, and making them first would follow the link.
    const landed = nearestExisting(dirname(target));
    if (landed !== inside && !landed.startsWith(inside + sep)) {
      refuse(
        `${path} is on ${args.ticket_key}'s admission record and writing it would land under ` +
          `${landed}, outside ${inside}. The loop commits the spec into the branch it is building ` +
          "and writes nowhere else",
        args.repository_root,
      );
    }
    // And the path itself, which the folder's answer says nothing about: a
    // recorded file the branch carries as a link is a write onto whatever it
    // points at, and a commit holding an unchanged link rather than the bytes.
    const found = lstatSync(target, { throwIfNoEntry: false });
    if (found?.isSymbolicLink() === true) {
      refuse(
        `${path} is on ${args.ticket_key}'s admission record and the worktree carries it as a link ` +
          `to ${readlinkSync(target)}. The loop writes the recorded bytes to the recorded path so ` +
          "the commit holds what approval recorded, and a link there holds something else",
        args.repository_root,
      );
    }
    if (found !== undefined && !found.isFile()) {
      refuse(
        `${path} is on ${args.ticket_key}'s admission record and the worktree has something there ` +
          "that is not a file. The loop writes the recorded bytes to the recorded path, and a " +
          "record names files",
        args.repository_root,
      );
    }
  }
  for (const [path, content] of bytes) {
    const target = join(args.worktree, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // Forced, because an ignore rule must not silently drop a recorded file: the
  // commit either holds what approval recorded or the run does not start.
  await git.stage(args.worktree, paths, { force: true, timeoutMs });
  const staged = await git.stagedPaths(args.worktree, paths, { timeoutMs });
  if (staged.length === 0) {
    // The base already holds every recorded file, so there is nothing for a
    // commit to add and nothing below the review to exclude that the base does
    // not already have.
    progress(`${args.base_commit.slice(0, 12)} already holds ${args.ticket_key}'s spec; no commit was made`);
    return { commit: null, paths };
  }
  const message =
    `${args.ticket_key}: the spec this change is judged against\n\n` +
    `Attempt: ${args.attempt_id}\nBase: ${args.base_commit}\n`;
  const commit = await git.commit(args.worktree, message, { timeoutMs });
  progress(
    `committed ${paths.length} spec file(s) as ${commit.slice(0, 12)}, the branch's first commit; ` +
      "the review reads the diff after it",
  );
  return { commit, paths };
}

/**
 * The spec commit a branch that already has commits carries.
 *
 * A commit is this branch's spec commit when it is the one the ticket's
 * attempts record names, or when it carries the loop's `Attempt:` trailer and
 * everything it changes is a file approval recorded. Both halves are needed:
 * the trailer says the loop made the commit, and the paths say it is the spec
 * one and not a sealed change set, whose paths this run excludes. A commit made
 * by hand takes the shape of the first but holds whatever was written, and no
 * hash here judges its contents. The trailer is provenance and not proof: it
 * is any `Attempt:` line, not one the ticket's record names, because an
 * attempt is recorded at the end of its round and a run that crashed after
 * making this commit would otherwise have its branch refused. Either answer is
 * the sha the seal excludes from and the attempt records.
 *
 * A branch whose first commit past the base is neither is not one this run may
 * add to: the review would read a range starting somewhere the record does not
 * describe, so it is refused with what was found. Where no run recorded a spec
 * commit and the first commit holds none, there is nothing to check and
 * nothing to make — a ticket whose branch was built before the loop committed
 * one keeps the branch it has, because a commit made now would not be first.
 */
async function confirmOnBranch(args: {
  worktree: string;
  repository_root: string;
  base_commit: string;
  ticket_key: string;
  paths: readonly string[];
  recorded: string | null;
  first: string;
  progress: (message: string) => void;
  timeoutMs: number;
}): Promise<SpecCommitResult> {
  const recordedPaths = new Set(args.paths);
  const changed = await changedPaths(args.worktree, args.base_commit, args.first, args.timeoutMs);
  const said = await git.run(args.worktree, ["log", "-1", "--format=%B", args.first], {
    timeoutMs: args.timeoutMs,
    maxOutputBytes: MAX_LISTING_BYTES,
  });
  const loops = /^Attempt: \S+$/m.test(said.stdout);
  const holdsTheSpec =
    loops && changed.length > 0 && changed.every((path) => recordedPaths.has(path));
  if (args.first === args.recorded || holdsTheSpec) return { commit: args.first, paths: [...args.paths] };
  if (args.recorded === null) {
    args.progress(
      `${args.ticket_key}'s branch has commits and no run recorded a spec commit for it; the ` +
        "branch keeps them, and the spec's files stay out of the change set",
    );
    return { commit: null, paths: [...args.paths] };
  }
  const subject = said.stdout.split("\n")[0]?.trim() ?? "";
  refuse(
    `${args.ticket_key}'s spec is in ${args.recorded.slice(0, 12)} and the first commit its branch ` +
      `carries past ${args.base_commit.slice(0, 12)} is ${args.first.slice(0, 12)} ` +
      `(${subject || "no subject"}), which changes ` +
      `${changed.length === 0 ? "nothing" : changed.join(", ")}. The review reads the diff after ` +
      "the spec commit, so a branch whose spec is not first is one to reconcile by hand before it " +
      "is run again",
    args.repository_root,
  );
}

/** What one commit changed against `base_commit`. */
async function changedPaths(
  worktree: string,
  base_commit: string,
  commit: string,
  timeoutMs: number,
): Promise<string[]> {
  const listed = await git.changedPaths(worktree, base_commit, commit, { timeoutMs });
  if (listed === null) throw new Error(`git could not list what ${commit} changed against ${base_commit}`);
  return listed.map((path) => path.trim()).filter((path) => path.length > 0);
}

/** The commits of `base_commit..HEAD` on the branch's own line, oldest first. */
async function firstParentCommits(
  worktree: string,
  base_commit: string,
  timeoutMs: number,
): Promise<string[]> {
  const listed = await git.runOrThrow(
    worktree,
    ["rev-list", "--reverse", "--first-parent", `${base_commit}..HEAD`],
    { timeoutMs, maxOutputBytes: MAX_LISTING_BYTES },
  );
  if (listed.truncated) {
    throw new Error(`${base_commit}..HEAD lists more than ${MAX_LISTING_BYTES} bytes of commits`);
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((sha) => sha.length > 0);
}
