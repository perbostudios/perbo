import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, resolve } from "node:path";
import { onePieceOfWork, standingProhibitedPaths, type PlanContract, type SpecFile, type Ticket } from "@perbo/contracts";
import {
  PlanningError,
  assertNoSymlink,
  assertNodePagesWritable,
  readSpecFile,
  writeNodePages,
} from "@perbo/planning";
import { UsageError } from "../usage-error.js";
import { INTERVIEW_SESSION_FILE } from "../commands/interview/index.js";
import { adrFolder, specFolder } from "../store/index.js";

/**
 * The spec folder beside a ticket: what a contract puts off limits, and the
 * page per node kept in it (D-103).
 *
 * A node's page is derived from the spec and the graph and from nothing else,
 * so the one rule here is *when*: every command that changes either rewrites
 * them in the same run. Nothing reads a page back except its Notes, which the
 * generator keeps.
 */

/**
 * The paths every contract admitted in this repository prohibits: the spec
 * folder, and `specs/**` whether or not that is where this repository keeps
 * them (D-103).
 *
 * A spec is what the contract was drafted from, so an attempt that edited one
 * would be rewriting the statement it is judged against. The runner's guard
 * holds the same list independently, for a ticket admitted before this and for
 * a run with no ticket behind it; this is what makes it visible on the contract
 * a person approves and what the reviewer's deterministic backstop reads.
 */
export function prohibitedSpecPaths(dir: string): string[] {
  return standingProhibitedPaths(specFolder(dir));
}

/**
 * Rewrite the page of every node of this plan, and remove the page of every
 * node it no longer has.
 *
 * Does nothing for a ticket not drafted from a spec: there is no folder to
 * write into, and inventing one would put a generated page beside code.
 */
export function regenerateNodePages(args: {
  repositoryRoot: string;
  ticket: Ticket;
  contract: PlanContract;
}): { written: string[]; removed: string[] } | null {
  return readNodePageInputs(args)?.write() ?? null;
}

/**
 * The spec a ticket's pages are generated from, read on its own so a command
 * can read it before its first write: an edit whose spec cannot be read is
 * refused whole rather than landed with its pages left behind.
 */
export function readNodePageInputs(args: {
  repositoryRoot: string;
  ticket: Ticket;
  /** The contract the pages will state: its nodes name the pages checked here. */
  contract: PlanContract;
}): { write: () => { written: string[]; removed: string[] } } | null {
  const recorded = args.ticket.admission.spec;
  if (recorded === null) return null;
  const path = resolve(args.repositoryRoot, recorded.path);
  let spec;
  try {
    assertNoSymlink(args.repositoryRoot, recorded.path);
    spec = readSpecFile(path).spec;
  } catch (error) {
    if (!(error instanceof PlanningError)) throw error;
    // The same refusal `perbo edit` gives for a citation it cannot check: the
    // pages state what the spec says, and a spec that cannot be read now is a
    // fact the person has to resolve rather than one to generate around.
    throw new UsageError(
      `${args.ticket.key} was drafted from ${recorded.path}, and its node pages are generated ` +
        `from that spec, which cannot be read now: ${error.message}`,
    );
  }
  const target = { repositoryRoot: args.repositoryRoot, specFolder: dirname(path), contract: args.contract };
  try {
    assertNodePagesWritable(target);
  } catch (error) {
    if (!(error instanceof PlanningError)) throw error;
    throw new UsageError(`${args.ticket.key}'s node pages cannot be written: ${error.message}`);
  }
  return { write: () => writeNodePages({ ...target, spec }) };
}

/**
 * The files the loop commits first on a ticket's branch (D-103): everything
 * under the spec's own folder, and the `CONTEXT.md` and ADRs the checkout has
 * changed since its last commit.
 *
 * The spec's folder is taken whole but for the interview's own session record
 * (D-102), because a page per node and a supporting file beside `spec.md` are
 * as much the statement the change is judged against as the spec is, while
 * that record is bookkeeping: it names the session writing the folder and is
 * rewritten by the next one, so committing it would put a hash on the record
 * that the following interview moves, and every later run would stop over a
 * spec nobody had edited. The other two are taken only where the checkout has
 * changed them, from `git status`: `CONTEXT.md` and the ADR folder belong to
 * the repository rather than to this ticket, and committing the ones nobody
 * touched would put every ADR on every branch.
 *
 * `spec.md` is first and the rest are sorted, so two admissions of the same
 * checkout record the same list in the same order.
 */
export function specCommitFiles(args: {
  repositoryRoot: string;
  /** The store, which names the ADR folder. */
  store: string;
  /** The spec's path relative to the repository, as admission records it. */
  specPath: string;
}): SpecFile[] {
  const specs = specFolder(args.store);
  // The precondition of the walk below, stated where the walk is: a path with
  // no folder of its own would take the repository from its root. Admission
  // refuses one before this is reached, so today no caller can get here with
  // one; this is what keeps that true of a caller written later.
  if (onePieceOfWork(args.specPath, specs) === null) {
    throw new UsageError(
      `${args.specPath} is recorded as this ticket's spec, and a spec lives at ${specs}/<slug>/` +
        "spec.md, in a folder of its own: the loop commits that folder and nothing outside it (D-103)",
    );
  }
  const folder = args.specPath.split("/").slice(0, -1).join("/");
  const inFolder = filesUnder(args.repositoryRoot, folder).filter(
    (path) => path !== args.specPath && !path.endsWith(`/${INTERVIEW_SESSION_FILE}`),
  );
  const changed = changedSince(args.repositoryRoot, ["CONTEXT.md", adrFolder(args.store)]);
  const paths = [args.specPath, ...inFolder.sort(), ...changed.sort()];
  return [...new Set(paths)].map((path) => ({
    path,
    content_sha256: `sha256:${createHash("sha256")
      .update(readFileSync(resolve(args.repositoryRoot, path)))
      .digest("hex")}`,
  }));
}

/**
 * Every file under one repository-relative folder, repository-relative,
 * unsorted, and none under a folder that cannot be read — which it says on
 * standard error, for the same reason {@link changedSince} does.
 */
function filesUnder(repositoryRoot: string, folder: string): string[] {
  const found: string[] = [];
  const walk = (relativePath: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(resolve(repositoryRoot, relativePath), { withFileTypes: true });
    } catch (error) {
      process.stderr.write(
        `warning: ${relativePath} could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "The spec is recorded without the files under it, once: nothing reads the folder again, " +
          "and the loop commits what this record names.\n",
      );
      return;
    }
    for (const entry of entries) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  walk(folder);
  return found;
}

/**
 * Which of `paths` the checkout has changed or added since its last commit,
 * repository-relative, and none where git cannot say — which it says on
 * standard error, because the list it leaves short is recorded as the files
 * the loop commits and nothing later asks git again.
 *
 * A path git reports as deleted is left out: the loop commits the bytes it
 * copies out of the checkout, and a file that is gone has none.
 */
function changedSince(repositoryRoot: string, paths: readonly string[]): string[] {
  let reported: string;
  try {
    reported = execFileSync(
      "git",
      ["-C", repositoryRoot, "status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr ?? (error as Error).message;
    const why = String(detail)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    process.stderr.write(
      `warning: git could not say which of ${paths.join(", ")} this checkout has changed` +
        `${why === undefined ? "" : `: ${why}`}. The spec is recorded without them, once: ` +
        "nothing asks git again, and the loop commits what this record names.\n",
    );
    return [];
  }
  // `XY <path>` per entry, and a rename or copy carries the path it came from
  // as the entry after it — which is a path the checkout no longer has.
  const fields = reported.split("\0").filter((field) => field.length > 0);
  const found: string[] = [];
  for (let at = 0; at < fields.length; at += 1) {
    const entry = fields[at]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) at += 1;
    if (existsSync(resolve(repositoryRoot, path))) found.push(path);
  }
  return found;
}
