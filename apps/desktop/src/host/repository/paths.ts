import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNeverReadPath } from "@perbo/contracts";
import type { RegisteredRepository } from "../profile/store.js";

/**
 * A path inside the registered repository, or a refusal. Every read and write
 * this host makes is resolved here: a path that leaves the checkout is refused,
 * and so is one that reaches its destination through a symlink, because a link
 * in the ticket store points wherever whoever wrote it chose.
 */
export function safePath(repo: RegisteredRepository, ...parts: string[]): string {
  const path = resolve(repo.path, ...parts),
    fragment = relative(repo.path, path);
  if (
    isAbsolute(fragment) ||
    fragment === ".." ||
    fragment.startsWith(`..${sep}`)
  )
    throw new Error("Path is outside the selected repository.");
  let cursor = repo.path;
  for (const part of fragment.split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error(
        "Perbo refuses a symlink in the ticket store. Use a repository-owned .perbo directory.",
      );
  }
  return path;
}

/**
 * A path a renderer named, as this repository's own. Absolute spellings and
 * `..` are refused here because `safePath` would resolve them to something
 * inside the repository and accept it; everything else — outside the
 * repository, a symlink on the way — `safePath` refuses.
 */
export function explorerPath(repo: RegisteredRepository, path: string): string {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path))
    throw new Error(
      "Name the file the way the repository does, relative to its root. Perbo does not take an absolute path from a screen.",
    );
  const relative = path.split(sep).join("/").replace(/^\.\//, "");
  if (relative === "" || relative.split("/").includes(".."))
    throw new Error("That path would leave the repository. Name a file inside it.");
  if (isNeverReadPath(relative))
    throw new Error(
      "Perbo never lists nor reads this path: it may hold a secret, Git metadata or agent configuration. That it exists is reportable; its contents are not.",
    );
  safePath(repo, relative);
  return relative;
}
