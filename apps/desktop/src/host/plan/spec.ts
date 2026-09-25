import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EMPTY_SPEC_TEXT,
  PlanningError,
  SpecConflict,
  assertNoSymlink,
  driftHash,
  parseSpec,
  readDriftRecord,
  readSpecText,
  requirementNodes,
  retitleSpecFile,
  writeDriftRecord,
  writeNodePages,
  writeSpecFile,
} from "@perbo/planning";
import { retitleSpec } from "@perbo/planning/browser";
import type { Ticket } from "@perbo/contracts";
import { specFolder } from "../repository/config.js";
import { perboPath } from "../repository/layout.js";
import { safePath } from "../repository/paths.js";
import { sectionsOf, titleChanged, type SpecReader } from "../../shared/contract-editing.js";
import { SPEC_SLUG } from "../../shared/protocol.js";
import { specSlugOf } from "../../shared/spec-slug.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { ChangeMarks } from "./marks.js";
import type { RegisteredRepository } from "../profile/store.js";
import type {
  Detail,
  RequestOf,
  SpecRow,
  SpecSaveReply,
  SpecSections,
  SpecView,
} from "../../shared/protocol.js";

/** What reading and writing a spec needs of the rest of the host. */
export interface SpecDeps {
  editing: Pick<ContractEditing, "read" | "recordSpec" | "personTitled">;
  repository(id: string): RegisteredRepository;
  contract(repo: RegisteredRepository, key: string): { contract: Detail["contract"] };
  marks: Pick<ChangeMarks, "markChangeOn">;
}

const EMPTY_SECTIONS: SpecSections = {
  outcome: "",
  requirements: "",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};

/** The file this planning's spec is written to, inside the repository's spec folder. */
export function specPath(repo: RegisteredRepository, slug: string): string {
  return safePath(repo, ...`${specFolder(repo)}/${slug}/spec.md`.split("/"));
}

/**
 * Each spec as its file states it, by repository id and slug — its title and
 * its five sections — for the drafts list to name a planning by and to say
 * whether its spec has moved since the contract was reached
 * (D-NEW-basic-and-epic-flows): null where the
 * repository or the file has gone or the file cannot be read.
 */
export function specTexts(repository: (id: string) => RegisteredRepository): SpecReader {
  return (repoId, slug) => {
    try {
      const { text } = readSpecText(specPath(repository(repoId), slug));
      return { title: text.title, sections: sectionsOf(text) };
    } catch {
      return null;
    }
  };
}

/** The title each spec states, as {@link specTexts} reads it. */
export function specTitles(
  repository: (id: string) => RegisteredRepository,
): (repoId: string, slug: string) => string | null {
  const read = specTexts(repository);
  return (repoId, slug) => read(repoId, slug)?.title ?? null;
}

/**
 * The five sections of a spec as its file says them, or null where there is
 * no file. A file that is there and cannot be read is thrown, since a reading
 * that failed is not an empty spec.
 */
export function specSectionsAt(repo: RegisteredRepository, slug: string): SpecSections | null {
  const path = specPath(repo, slug);
  return existsSync(path) ? sectionsOf(readSpecText(path).text) : null;
}

/**
 * Every spec this repository holds, by slug, with the title it states.
 *
 * Read from the folder rather than from the records, because the specs worth
 * offering are the ones no record names, and nothing else enumerates this
 * folder. Deleting a piece of work takes its spec with it, so what is left here
 * was written some other way: committed by somebody else or written at the
 * command line (D-129).
 *
 * A folder this cannot make sense of is skipped rather than refused: the picker
 * is a way back in, and one unreadable spec is not a reason to offer none of
 * the others. A symlinked entry is not a directory to `readdirSync`, so it is
 * never followed, and a name outside the slug's own shape is left alone
 * because nothing could record it.
 */
export function repositorySpecs(repo: RegisteredRepository): SpecRow[] {
  let root: string;
  try {
    root = safePath(repo, ...specFolder(repo).split("/"));
  } catch {
    return [];
  }
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !SPEC_SLUG.test(entry.name)) return [];
    try {
      const { text } = readSpecText(join(root, entry.name, "spec.md"));
      const title = text.title.trim();
      return title.length > 0 ? [{ repoId: repo.id, slug: entry.name, title }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The spec a ticket still being planned was drafted from, titled with the name
 * the person just gave the ticket, so the Spec pane, the picker and the
 * contract's head show one name (D-127).
 * True where the spec was renamed.
 *
 * Written through `retitleSpecFile`, the one writer of that rule, and only its
 * title line: the folder keeps its slug. Not for an approved ticket, whose spec
 * is what the run commits and checks against the hash approval recorded
 * (D-103), so renaming it there would stop the run; nor for a ticket whose
 * spec is not where its record says.
 *
 * The verdict the plan was read against its spec with is carried to the
 * renamed bytes where it was keyed on the bytes before: the title line is not
 * what the reading reads (D-128). It is written before the spec, so a record
 * that cannot be written refuses the rename with the spec as it was; a spec
 * write that fails after it leaves a record keyed to bytes that are not on
 * disk, which vouches for nothing and costs the next visit a reading.
 */
export async function nameSpecAfterRename(
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> },
  repo: RegisteredRepository,
  key: string,
  title: string,
): Promise<boolean> {
  const ticket = (await tickets.list(repo)).tickets.find((entry) => entry.key === key);
  if (ticket === undefined || ticket.approved_at) return false;
  const folder = specFolder(repo);
  const slug = specSlugOf(ticket.admission.spec?.path, folder);
  if (slug === null) return false;
  const path = `${folder}/${slug}/spec.md`;
  const at = safePath(repo, ...path.split("/"));
  if (!existsSync(at)) return false;
  // The renamed bytes are worked out before either file is written, from the
  // file as the retitle reads it, so every refusal the retitle makes comes
  // before the drift record moves.
  assertNoSymlink(repo.path, path);
  const before = driftHash(readFileSync(at));
  const after = driftHash(retitleSpec(readSpecText(at).markdown, title));
  if (after !== before) carryDriftToRetitle(perboPath(repo), key, before, after);
  retitleSpecFile({ repositoryRoot: repo.path, path, title });
  return true;
}

/** The drift record keyed on the spec's bytes before a retitle, keyed on them after it. */
function carryDriftToRetitle(store: string, key: string, before: string, after: string): void {
  let record;
  try {
    record = readDriftRecord(store, key);
  } catch (error) {
    // A record that does not read is left for `perbo drift` to name.
    if (error instanceof PlanningError) return;
    throw error;
  }
  if (record !== null && record.spec === before) writeDriftRecord(store, key, { ...record, spec: after });
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
  // Saved as written. What the spec states and what the plan cites are settled
  // on the contract page and at approval, not here
  // (D-128).
  //
  // What the file said before, for the change this save records, the person's:
  // nothing at all where there is no file yet, so a first save is a change from
  // nothing, and no reading where the file will not read, so the save is not
  // measured.
  let before: SpecSections | null | undefined;
  try {
    before = session.specSlug === null ? null : specSectionsAt(repo, session.specSlug);
  } catch {
    before = undefined;
  }
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
  // A title this save changed from the one its writer read is one the person
  // typed: the plan is drafted under it (D-127). A save of a section alone
  // sends the title it read, and names nobody.
  if (titleChanged(request)) deps.editing.personTitled(request.id, request.title);
  refreshNodePages(deps, repo, request.id, written.path);
  // The change this save made, on every planning writing this spec: a save of
  // the same words changes nothing and marks nothing. The save has landed
  // whatever the marking does, so a file that will not read back marks nothing
  // rather than failing it.
  if (before !== undefined) {
    let after: SpecSections | null | undefined;
    try {
      after = specSectionsAt(repo, written.slug);
    } catch {
      after = undefined;
    }
    if (after !== undefined)
      deps.marks.markChangeOn(
        { spec: before, plan: null },
        { spec: after, plan: null },
        (each) => each.repoId === repo.id && each.specSlug === written.slug,
        "person",
      );
  }
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
