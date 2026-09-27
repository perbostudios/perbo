import { readFileSync, statSync } from "node:fs";
import { PlanningError } from "./errors.js";
import { SPEC_HEADINGS, type Spec, type SpecHeading, type SpecRequirement } from "./spec-text.js";

/**
 * A spec: the intent upstream of one ticket's contract, written in the
 * repository at `specs/<slug>/spec.md` (D-103).
 *
 * It is read here and drafted from exactly as an issue is — the same delimited
 * external-trust block, the same one call, the same closed schema back. What a
 * spec adds is requirement ids, which a criterion may cite, and a No-Gos
 * heading, which is where the approach record's No-Gos come from. Nothing in
 * this file obeys the document it is reading.
 */

/** The largest spec this reads, for the reason `--from-file` has a bound. */
export const MAX_SPEC_FILE_BYTES = 1024 * 1024;

const LIST_ITEM = /^[-*]\s+(.*)$/;
const REQUIREMENT = /^(R\d+):\s*(.+)$/;

const listItems = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => {
    const match = LIST_ITEM.exec(line.trim());
    return match ? [match[1]!.trim()] : [];
  });

const prose = (lines: readonly string[]): string => lines.join("\n").trim();

/**
 * Split the document into its title and its `##` sections. A spec with no `#`
 * heading has an empty title: nobody has named the work yet, and its ticket is
 * named without it (D-118, D-127).
 *
 * A `##` heading that is not one of the five is refused rather than ignored:
 * silently dropping `## No-Go` would give a ticket no No-Gos and say nothing
 * about it, and a typo there is the likeliest way to lose one.
 */
function sections(markdown: string): { title: string; sections: Map<SpecHeading, string[]> } {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  let title: string | null = null;
  const found = new Map<SpecHeading, string[]>();
  let current: string[] | null = null;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (!heading) {
      current?.push(line);
      continue;
    }
    const [, hashes, text] = heading as unknown as [string, string, string];
    const name = text.trim();
    if (hashes.length === 1) {
      if (title === null) title = name;
      current = null;
      continue;
    }
    if (hashes.length > 2) {
      current?.push(line);
      continue;
    }
    const known = SPEC_HEADINGS.find((candidate) => candidate === name);
    if (known === undefined) {
      throw new PlanningError(
        `the spec has a section '${name}', which is not one a spec has. A spec's sections are ` +
          `${SPEC_HEADINGS.join(", ")} (D-103)`,
      );
    }
    if (found.has(known)) {
      throw new PlanningError(`the spec has two '${known}' sections; it may have one`);
    }
    current = [];
    found.set(known, current);
  }

  return { title: title ?? "", sections: found };
}

function requirementsOf(lines: readonly string[]): SpecRequirement[] {
  const requirements: SpecRequirement[] = [];
  const seen = new Set<string>();
  for (const item of listItems(lines)) {
    const match = REQUIREMENT.exec(item);
    if (!match) {
      throw new PlanningError(
        `the spec's requirement '${item}' does not begin with its id. Write each one as ` +
          "'- R1: what must be true', with ids R1 upward, never reused (D-103)",
      );
    }
    const [, id, text] = match as unknown as [string, string, string];
    if (!/^R[1-9]\d*$/.test(id)) {
      throw new PlanningError(
        `the spec's requirement id '${id}' is not one: ids run R1 upward, with no leading zero`,
      );
    }
    if (seen.has(id)) {
      throw new PlanningError(
        `the spec uses the requirement id ${id} twice. An id is written once and never reused, ` +
          "because a criterion cites it",
      );
    }
    seen.add(id);
    requirements.push({ id, text: text.trim() });
  }
  if (requirements.length === 0) {
    throw new PlanningError(
      "the spec's Requirements section names no requirement. Write each one as " +
        "'- R1: what must be true'; there is nothing to draft a contract from without them",
    );
  }
  return requirements;
}

/** One spec, parsed. Every failure is one sentence a person can act on. */
export function parseSpec(markdown: string): Spec {
  const document = sections(markdown);
  for (const required of ["Outcome", "Requirements"] as const) {
    if (!document.sections.has(required)) {
      throw new PlanningError(
        `the spec has no '## ${required}' section. A spec states its Outcome and its ` +
          "Requirements; No-Gos, Rabbit holes and Notes are optional (D-103)",
      );
    }
  }
  const outcome = prose(document.sections.get("Outcome")!);
  if (outcome.length === 0) {
    throw new PlanningError("the spec's Outcome section is empty: one sentence, what will be true");
  }
  return {
    title: document.title,
    outcome,
    requirements: requirementsOf(document.sections.get("Requirements")!),
    no_gos: listItems(document.sections.get("No-Gos") ?? []),
    rabbit_holes: listItems(document.sections.get("Rabbit holes") ?? []),
    notes: prose(document.sections.get("Notes") ?? []),
  };
}

/**
 * Read one spec file. Every failure a person can cause — no file, a directory,
 * an unreadable file — is one sentence naming the path, as `--from-file` is.
 */
export function readSpecFile(path: string): { spec: Spec; markdown: string } {
  let bytes: number;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      throw new PlanningError(`${path} is a directory; --from-spec takes the spec.md inside it`);
    }
    bytes = stat.size;
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new PlanningError(
      code === "ENOENT"
        ? `no spec at ${path}`
        : `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (bytes > MAX_SPEC_FILE_BYTES) {
    throw new PlanningError(
      `${path} is ${Math.round(bytes / 1024)} KiB, past the ${MAX_SPEC_FILE_BYTES / 1024} KiB a ` +
        "spec may be",
    );
  }
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    throw new PlanningError(
      `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { spec: parseSpec(markdown), markdown };
}
