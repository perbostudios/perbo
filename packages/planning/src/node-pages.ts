import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { assertNoSymlink, relativeInside } from "./spec-write.js";
import { join } from "node:path";
import { planNodes, type PlanContract } from "@perbo/contracts";
import { nodePageNotes, renderNodePage } from "./node-page-text.js";
import type { Spec } from "./spec-text.js";

/**
 * The page a node gets beside its spec: `specs/<slug>/nodes/<node>.md` (D-103).
 *
 * It exists so a node reads on its own — what it is for, what it has to prove
 * and where — without giving a requirement a second place to be written. The
 * text is `node-page-text.ts`'s; this is where it lands on disk, and which
 * pages are removed when a graph edit takes a node away.
 */

/** Where a node's page is: `<spec folder>/nodes/<node id>.md`. */
const nodePagePath = (specFolder: string, nodeId: string): string =>
  join(specFolder, "nodes", `${nodeId}.md`);

/**
 * Nothing here is written through a link: not the spec folder, not the nodes
 * folder, not a page. Each is checked from the repository root, so a link
 * anywhere on the way is refused before the first write, and a command that
 * writes other records first asks this before any of them.
 */
export function assertNodePagesWritable(args: {
  repositoryRoot: string;
  specFolder: string;
  contract: PlanContract;
}): void {
  const folder = relativeInside(args.repositoryRoot, args.specFolder);
  assertNoSymlink(args.repositoryRoot, `${folder}/nodes`);
  for (const node of planNodes(args.contract)) {
    assertNoSymlink(args.repositoryRoot, `${folder}/nodes/${node.id}.md`);
  }
}

/**
 * Write the page of every node the plan has and remove the page of every node
 * it no longer has.
 *
 * A `.md` under `nodes/` that no node of this plan claims is removed, because
 * it is the page of a node a graph edit deleted and a reader would take it for
 * current. Anything else in the folder is left where it is: the folder is in
 * the repository and a person may keep a file of their own beside the pages.
 */
export function writeNodePages(args: {
  /** The repository the spec folder is in: every write is checked from here. */
  repositoryRoot: string;
  /** The spec's own folder, absolute: the `specs/<slug>` holding `spec.md`. */
  specFolder: string;
  spec: Spec;
  contract: PlanContract;
}): { written: string[]; removed: string[] } {
  const nodes = planNodes(args.contract);
  const directory = join(args.specFolder, "nodes");
  const written: string[] = [];
  assertNodePagesWritable(args);
  if (nodes.length > 0) mkdirSync(directory, { recursive: true });
  for (const node of nodes) {
    const path = nodePagePath(args.specFolder, node.id);
    let notes = "";
    try {
      notes = nodePageNotes(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(path, renderNodePage({ node, spec: args.spec, contract: args.contract, notes }));
    written.push(path);
  }

  const keep = new Set(nodes.map((node) => `${node.id}.md`));
  let present: string[] = [];
  try {
    present = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const removed: string[] = [];
  for (const name of present) {
    if (!/^node_[0-9A-Za-z][0-9A-Za-z_-]{0,31}\.md$/.test(name) || keep.has(name)) continue;
    const path = join(directory, name);
    rmSync(path, { force: true });
    removed.push(path);
  }
  return { written, removed: removed.sort() };
}
