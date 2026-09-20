import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  EMPTY_SPEC_TEXT,
  PlanningError,
  SpecConflict,
  parseSpec,
  readSpecText,
  requirementNodes,
  writeNodePages,
  writeSpecFile,
} from "@perbo/planning";
import { specFolder } from "../repository/config.js";
import { safePath } from "../repository/paths.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { RegisteredRepository } from "../profile/store.js";
import type {
  Detail,
  RequestOf,
  SpecSaveReply,
  SpecSections,
  SpecView,
} from "../../shared/protocol.js";

/** What reading and writing a spec needs of the rest of the host. */
export interface SpecDeps {
  editing: Pick<ContractEditing, "read" | "recordSpec">;
  repository(id: string): RegisteredRepository;
  contract(repo: RegisteredRepository, key: string): { contract: Detail["contract"] };
}

const EMPTY_SECTIONS: SpecSections = {
  outcome: "",
  requirements: "",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};

/** The file this planning's spec is written to, inside the repository's spec folder. */
function specPath(repo: RegisteredRepository, slug: string): string {
  return safePath(repo, ...`${specFolder(repo)}/${slug}/spec.md`.split("/"));
}

/**
 * One planning session's spec, read from the repository (D-103).
 *
 * The file is what this says. Between one save and the next the repository
 * holds the spec, so a spec edited outside the app — by hand, or in a second
 * window — is what the pane shows the next time it reads.
 */
export function specView(deps: SpecDeps, id: string): SpecView {
  const session = deps.editing.read(id);
  if (session.specSlug === null)
    return { slug: null, path: null, title: "", sections: EMPTY_SECTIONS, requirements: [] };
  const repo = deps.repository(session.repoId);
  const path = `${specFolder(repo)}/${session.specSlug}/spec.md`;
  const read = readSpecText(specPath(repo, session.specSlug));
  // The nodes a requirement landed in come from the contract this session
  // holds, where it holds one; before the first draft every answer is none.
  const held = session.key ? deps.contract(repo, session.key).contract : null;
  // P0 has neither criteria nor nodes, so it lands no requirement anywhere.
  const contract = held !== null && "acceptance_criteria" in held ? held : null;
  const carried = requirementNodes(
    {
      requirements: read.requirements.flatMap((each) =>
        each.id === null ? [] : [{ id: each.id, text: each.text }],
      ),
    },
    contract,
  );
  return {
    slug: session.specSlug,
    path,
    title: read.text.title,
    sections: {
      outcome: read.text.outcome,
      requirements: read.text.requirements,
      no_gos: read.text.no_gos,
      rabbit_holes: read.text.rabbit_holes,
      notes: read.text.notes,
    },
    requirements: read.requirements.map((each) => ({
      id: each.id,
      text: each.text,
      nodes: carried.find((carry) => carry.id === each.id)?.nodes ?? [],
    })),
  };
}

/**
 * Rewrite the page of each node beside a spec that has just been written
 * (D-103): a page states what the spec and the graph say, and the spec has
 * just moved. Nothing to do until this session holds a plan.
 *
 * A spec still being written has no Outcome or no requirement yet and is not
 * one pages can be generated from; its pages are left as they are until it is
 * complete, which the next save does.
 */
function refreshNodePages(
  deps: SpecDeps,
  repo: RegisteredRepository,
  id: string,
  path: string,
): void {
  const session = deps.editing.read(id);
  if (session.key === null) return;
  const contract = deps.contract(repo, session.key).contract;
  let spec;
  try {
    spec = parseSpec(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof PlanningError) return;
    throw error;
  }
  writeNodePages({ repositoryRoot: repo.path, specFolder: dirname(path), spec, contract });
}

/**
 * The spec as this pane just wrote it, or the file as it stands where another
 * writer moved it first.
 *
 * A section the interview or the Impact pane wrote since this writer read the
 * file is not an error a person can only read: the file comes back with the
 * refusal, so the pane shows both texts and neither side's words are lost
 * (SCP-321). Nothing was written.
 *
 * The file is read again rather than rebuilt from the refusal, which carries
 * the five sections and not the requirement ids or the nodes behind them. A
 * file that moved once more in between refuses the next save as well, so
 * nothing is overwritten either way.
 */
export function saveSpec(
  deps: SpecDeps,
  repo: RegisteredRepository,
  request: RequestOf<"specSave">,
): SpecSaveReply {
  const session = deps.editing.read(request.id);
  if (session.repoId !== repo.id)
    throw new Error("This planning belongs to another repository.");
  let written;
  try {
    written = writeSpecFile({
      repositoryRoot: repo.path,
      folder: specFolder(repo),
      slug: session.specSlug,
      text: { title: request.title, ...request.sections },
      base: { title: request.base.title, ...request.base.sections },
    });
  } catch (error) {
    if (error instanceof SpecConflict)
      return { view: specView(deps, request.id), conflicting: [...error.conflicting] };
    throw error;
  }
  deps.editing.recordSpec(request.id, written.slug);
  refreshNodePages(deps, repo, request.id, written.path);
  return { view: specView(deps, request.id), conflicting: [] };
}

/**
 * A spec named from a title, minted in the repository's spec folder. The
 * folder is minted once and never moves, so what it was called is worth
 * saying while the spec is still empty enough to start again.
 */
export function mintSpecFromTitle(
  repo: RegisteredRepository,
  title: string,
): { slug: string; folder: string } {
  const written = writeSpecFile({
    repositoryRoot: repo.path,
    folder: specFolder(repo),
    slug: null,
    text: { ...EMPTY_SPEC_TEXT, title },
    base: EMPTY_SPEC_TEXT,
  });
  return { slug: written.slug, folder: written.folder };
}
