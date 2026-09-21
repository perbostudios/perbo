import { hasAcceptanceCriteria, type PlanContract, type PlanNode } from "@perbo/contracts/browser";
import type { Spec } from "./spec-text.js";

/**
 * The text of the page a node gets beside its spec (D-103), and no filesystem
 * at all — `node-pages.ts` is what puts it on disk.
 *
 * Every line of it is derived: the requirements come from the criteria that
 * cite them, the criteria and paths from the contract, the No-Gos from the
 * spec. So the page is regenerated whenever either changes and is never read
 * back as input, except for its Notes, which are a person's. Split from the
 * writer so the desktop's browser preview renders the page the command line
 * would, having no filesystem to read one from.
 */

/** The heading the generated part ends at. Everything after it is a person's. */
export const NODE_PAGE_NOTES = "## Notes";

/** Where a page says it came from, so a reader knows not to edit above the Notes. */
const PROVENANCE =
  "Generated from `spec.md` and the plan's graph. Everything above Notes is rewritten " +
  "whenever either changes; Notes is yours and is kept.";

/** The Notes a page carries, or the empty string where it has none yet. */
export function nodePageNotes(markdown: string): string {
  const at = markdown.indexOf(`\n${NODE_PAGE_NOTES}`);
  if (at === -1) return "";
  return markdown.slice(at + NODE_PAGE_NOTES.length + 1).trim();
}

const bullets = (lines: readonly string[], empty: string): string =>
  lines.length === 0 ? empty : lines.map((line) => `- ${line}`).join("\n");

/** One node's page, with the Notes it is to keep. */
export function renderNodePage(args: {
  node: PlanNode;
  spec: Spec;
  contract: PlanContract;
  notes: string;
}): string {
  const { node, spec, contract } = args;
  const criteria = hasAcceptanceCriteria(contract) ? contract.acceptance_criteria : [];
  const held = node.criteria.flatMap((id) => criteria.filter((criterion) => criterion.id === id));
  const cited = new Set(held.flatMap((criterion) => criterion.requirement_id ?? []));
  return (
    `# ${node.title}\n\n` +
    `${PROVENANCE}\n\n` +
    `## Requirements\n\n` +
    `${bullets(
      spec.requirements
        .filter((requirement) => cited.has(requirement.id))
        .map((requirement) => `${requirement.id}: ${requirement.text}`),
      "No requirement of this spec is derived to this node yet.",
    )}\n\n` +
    `## Criteria\n\n` +
    `${
      held.length === 0
        ? "This node holds no criterion."
        : held
            .map(
              (criterion) =>
                `- ${criterion.id}: ${criterion.text}\n` +
                `  - proven by (${criterion.expected_verification.kind}): ` +
                `${criterion.expected_verification.assertion}` +
                (criterion.requirement_id === undefined
                  ? ""
                  : `\n  - drafted from ${criterion.requirement_id}`),
            )
            .join("\n")
    }\n\n` +
    `## Paths\n\n` +
    `${bullets(node.paths, "This node names no path.")}\n\n` +
    `## No-Gos\n\n` +
    `${bullets(spec.no_gos, "The spec states none.")}\n\n` +
    `${NODE_PAGE_NOTES}\n\n` +
    `${args.notes}${args.notes.length > 0 ? "\n" : ""}`
  );
}
