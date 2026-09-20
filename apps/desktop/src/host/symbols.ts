import { SymbolIndexSchema, UnsupportedRepositorySchema, isNeverReadPath } from "@perbo/contracts";
import type { SymbolIndex, UnsupportedRepository } from "@perbo/contracts";
import { requireSuccess } from "./process.js";
import { trackedFiles, type Execute } from "./repository/git.js";
import type { Cli } from "./cli.js";
import type { WorkspaceReads } from "./workspace-reads.js";
import type { RegisteredRepository } from "./profile/store.js";
import type { SymbolIndexView } from "../shared/protocol.js";

/**
 * This repository's symbol and import index, read fresh from `perbo index`
 * (D-015). The Spec pane's `@Symbol` completion and the Impact pane's
 * warnings both read it here.
 *
 * The command is run for the answer rather than `.perbo/index.json` read
 * off disk: nothing keeps that file fresh, and a stale one would let the
 * Spec pane mark a name that has since appeared, or the Impact pane miss an
 * importer that has since arrived. The record comes back on stdout and is
 * held to the schema the contract declares; a repository the index cannot
 * describe answers `supported: false`, which is a different fact from an
 * index holding no files, so the two are parsed against their own schemas
 * and never flattened into one.
 */
export async function readSymbolIndex(
  cli: Pick<Cli, "run">,
  repo: RegisteredRepository,
): Promise<SymbolIndex | UnsupportedRepository> {
  const record: unknown = JSON.parse(
    requireSuccess(await cli.run(["index", "--json"], repo)),
  );
  return record !== null && typeof record === "object" && "supported" in record
    ? UnsupportedRepositorySchema.parse(record)
    : SymbolIndexSchema.parse(record);
}

/**
 * The exported names the Spec pane completes `@Symbol` from, and marks
 * against (D-015, SCP-321).
 *
 * The names come from the index and from nothing the renderer sent
 * ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) §4).
 * Building the index reads the whole tracked tree, so the five sections
 * asking at once share one run.
 */
export async function exportedNames(
  deps: { cli: Pick<Cli, "run">; reads: WorkspaceReads; execute: Execute },
  repo: RegisteredRepository,
): Promise<SymbolIndexView> {
  return deps.reads.read("symbols:" + repo.id, repo.id, async () => {
    const index = await readSymbolIndex(deps.cli, repo);
    if ("supported" in index)
      return { supported: false, reason: index.reason, languages: index.languages_seen };
    // `perbo index` parses the whole tracked tree and has no never-read
    // filter of its own, so a file this surface may not name can export a
    // symbol (ADR-0030). Both halves of what a name carries would cross: the
    // name itself, and the path the popup prints beside it. Nothing outside
    // the list the explorer would show is offered.
    const named = new Set((await trackedFiles(deps.execute, repo.path)).filter((path) => !isNeverReadPath(path)));
    return {
      supported: true,
      names: index.files
        .filter((file) => named.has(file.path))
        .flatMap((file) =>
          file.exports
            // `export * from` records the name `*`, which is not a name a spec
            // can refer to: what it exports is not knowable without reading the
            // file it names.
            .filter((each) => each.name !== "*")
            .map((each) => ({ name: each.name, kind: each.kind, path: file.path })),
        ),
      headCommit: index.head_commit,
      workingTree: index.working_tree,
      builtAt: index.built_at,
    };
  });
}
