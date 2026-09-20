import { isNeverReadPath } from "@perbo/contracts";
import { impactReport, readSpecText } from "@perbo/planning";
import { specFolder } from "../repository/config.js";
import { safePath } from "../repository/paths.js";
import { trackedFiles, type Execute } from "../repository/git.js";
import { readSymbolIndex } from "../symbols.js";
import type { Cli } from "../cli.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { ImpactView } from "../../shared/protocol.js";

/** What deriving the impact warnings needs of the rest of the host. */
export interface ImpactDeps {
  editing: Pick<ContractEditing, "read">;
  repository(id: string): RegisteredRepository;
  cli: Pick<Cli, "run">;
  execute: Execute;
}

/**
 * The impact warnings for one planning session's draft (D-015, SCP-320).
 *
 * Derived when a person asks the pane for them and never on its own: the
 * index is a parse of the whole tracked tree, which is not work to do because
 * a pane was opened.
 *
 * Every input is the host's own — the tracked tree from Git in the registered
 * repository, the scope off the session's form, the spec off the file the
 * session records — so nothing a renderer sent reaches a path or an argument
 * (ADR-0023 §4). Asking changes neither the draft nor the spec: it rebuilds
 * the index file `perbo index` keeps at `.perbo/index.json`, and the
 * pane's two actions are the draft's own mark and the spec's own save.
 *
 * The never-read paths are dropped before the warnings are derived, as the
 * explorer drops them from its listing: a path no surface reads is not one to
 * offer a person for their scope. They are dropped from the tracked list
 * alone: `perbo index` reads the whole tree and has no never-read filter of
 * its own, so what keeps them off the screen is `impactReport` naming nothing
 * outside that list — inside a warning's sentence as much as in its path.
 */
export async function impactView(deps: ImpactDeps, id: string): Promise<ImpactView> {
  const session = deps.editing.read(id);
  const repo = deps.repository(session.repoId);
  const tracked = (await trackedFiles(deps.execute, repo.path)).filter((path) => !isNeverReadPath(path));
  const spec =
    session.specSlug === null
      ? null
      : readSpecText(
          safePath(
            repo,
            ...`${specFolder(repo)}/${session.specSlug}/spec.md`.split("/"),
          ),
        ).markdown;
  const report = impactReport({
    scope: session.form.draft.paths,
    tracked,
    spec,
    index: await readSymbolIndex(deps.cli, repo),
  });
  return { ...report, readAt: new Date().toISOString() };
}
