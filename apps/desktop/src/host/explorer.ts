import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isNeverReadPath, readStandingProhibited } from "@perbo/contracts";
import { readConfig } from "./repository/config.js";
import { explorerPath, safePath } from "./repository/paths.js";
import { trackedFiles, type Execute } from "./repository/git.js";
import { PREVIEW_BYTE_CAP } from "../shared/protocol.js";
import type { RegisteredRepository } from "./profile/store.js";
import type { ExplorerFile, ExplorerListing } from "../shared/protocol.js";

/**
 * What the explorer lists: the repository's tracked files, with the paths no
 * surface reads withheld (D-015, ADR-0030). That they exist is reportable —
 * the count says how many — and their contents are not.
 */
export async function listExplorer(
  execute: Execute,
  repo: RegisteredRepository,
): Promise<ExplorerListing> {
  const tracked = await trackedFiles(execute, repo.path);
  const files = tracked.filter((path) => !isNeverReadPath(path)).sort();
  return {
    files,
    hidden: tracked.length - files.length,
    standing: readStandingProhibited(readConfig(repo)),
  };
}
/**
 * One file, read-only (D-015). A file larger than the cap or holding a NUL
 * byte comes back with the reason and no text: a truncated preview reads as
 * the whole file, and a decoded binary is not text.
 */
export async function readExplorerFile(
  execute: Execute,
  repo: RegisteredRepository,
  requested: string,
): Promise<ExplorerFile> {
  const path = explorerPath(repo, requested);
  const full = safePath(repo, path);
  if (!existsSync(full)) throw new Error(`${path} is not a tracked file in this repository.`);
  if (lstatSync(full).isDirectory())
    throw new Error(`${path} is a folder. The tree already lists what is in it.`);
  if (!(await trackedFiles(execute, repo.path)).includes(path))
    throw new Error(`${path} is not a tracked file in this repository.`);
  const bytes = lstatSync(full).size;
  const refuse = (refusal: string): ExplorerFile => ({ path, bytes, text: null, refusal });
  if (bytes > PREVIEW_BYTE_CAP)
    return refuse(
      `${path} is larger than the 256 KiB the preview reads, so nothing is shown rather than part of it. Open it in your editor.`,
    );
  const raw = readFileSync(full);
  if (raw.includes(0))
    return refuse(`${path} is a binary file. There is nothing here to read.`);
  return { path, bytes, text: raw.toString("utf8"), refusal: null };
}
