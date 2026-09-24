import { isNeverReadPath } from "@perbo/contracts";
import { impactReport, readSpecText } from "@perbo/planning";
import { safePath } from "../repository/paths.js";
import { specPath } from "./spec.js";
import { trackedFiles, type Execute } from "../repository/git.js";
import { readSymbolIndex } from "../symbols.js";
import type { Cli } from "../cli.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { TicketRecords } from "../tickets/open.js";
import type { ImpactView } from "../../shared/protocol.js";

/** What deriving the impact warnings needs of the rest of the host. */
export interface ImpactDeps {
  editing: Pick<ContractEditing, "read">;
  repository(id: string): RegisteredRepository;
  cli: Pick<Cli, "run">;
  execute: Execute;
}

/** What the same reading needs of a ticket, where there is no session to ask. */
export interface ContractImpactDeps {
  tickets: TicketRecords;
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
      : readSpecText(specPath(repo, session.specSlug)).markdown;
  const report = impactReport({
    scope: session.form.draft.paths,
    tracked,
    spec,
    index: await readSymbolIndex(deps.cli, repo),
  });
  return { ...report, readAt: new Date().toISOString() };
}

/**
 * The same reading, asked of a compiled contract rather than of a draft
 * (D-015, SCP-320).
 *
 * The derivation {@link impactView} makes of a session's draft, made instead
 * of the contract: its own allowed paths, and the spec the ticket records
 * having been drafted from where there is one. Read from the ticket rather
 * than from a planning session, because the contract page is reached from a
 * ticket — one the CLI admitted has no session to ask, and a person approving
 * it is making exactly the same decision.
 *
 * The spec is read from the path the ticket recorded, and a spec that has
 * since gone leaves the reading to the scope alone rather than failing: a
 * warning is advice, and advice that cannot be given is not an error on the
 * page that approves.
 */
export async function contractImpact(
  deps: ContractImpactDeps,
  repoId: string,
  key: string,
): Promise<ImpactView> {
  const repo = deps.repository(repoId);
  const { contract } = deps.tickets.contract(repo, key);
  const ticket = (await deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
  const tracked = (await trackedFiles(deps.execute, repo.path)).filter(
    (path) => !isNeverReadPath(path),
  );
  const at = ticket?.admission?.spec?.path ?? null;
  let spec: string | null = null;
  if (at !== null) {
    try {
      spec = readSpecText(safePath(repo, ...at.split("/"))).markdown;
    } catch {
      spec = null;
    }
  }
  const report = impactReport({
    scope: contract.scope.paths_allowed,
    tracked,
    spec,
    index: await readSymbolIndex(deps.cli, repo),
  });
  return { ...report, readAt: new Date().toISOString() };
}
