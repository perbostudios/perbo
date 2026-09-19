import { createHash } from "node:crypto";
import { z } from "zod";
import { CommitShaSchema, CriterionIdSchema } from "./ids.js";
import {
  PlanContractSchema,
  VerificationKindSchema,
  type PlanContractWithCriteria,
  type VerificationKind,
} from "./plan.js";

/**
 * A contract that was never admitted (SCP-179).
 *
 * `perbo review` on a pull request Perbo never planned still needs something
 * to judge the change against, and the only honest place to get it is the thing
 * the author already wrote: the pull request's title and body, or the flags the
 * person typed. This module is that reading, and its whole discipline is in one
 * rule — **what the source did not state is recorded as absent**. An outcome
 * with no criteria under it is an outcome with no criteria under it; inventing
 * three plausible ones would produce a review that grades the change against a
 * plan nobody wrote, and score it green.
 *
 * The source contract is therefore not a `PlanContract`. It is what a source
 * said, with its provenance, and `planContractFromSource` mints the plan the
 * reviewer runs on from it — which is where the difference between "stated" and
 * "assumed" is written down rather than lost.
 */

export const CONTRACT_SOURCES = ["pull_request", "arguments"] as const;
export const ContractSourceSchema = z.enum(CONTRACT_SOURCES);
export type ContractSource = (typeof CONTRACT_SOURCES)[number];

/**
 * Where the outcome was read from, because "the pull request stated it" and
 * "we fell back to the title" are different claims and the second one is
 * weaker. A reader of the bundle should not have to guess which happened.
 */
export const OUTCOME_ORIGINS = ["stated", "first_paragraph", "title", "argument"] as const;
export const OutcomeOriginSchema = z.enum(OUTCOME_ORIGINS);
export type OutcomeOrigin = (typeof OUTCOME_ORIGINS)[number];

/**
 * A criterion as a source stated it — which is less than an approved plan's.
 *
 * `assertion` is nullable here and is not in `AcceptanceCriterion`: an approved
 * criterion must name what will prove it (that check is the product), but a
 * pull request body is not an approval, and a criterion written there without
 * an assertion is a real thing a real author wrote. It is carried as stated,
 * with `assertion: null` saying so.
 */
export const SourceCriterionSchema = z.strictObject({
  id: CriterionIdSchema,
  text: z.string().min(1),
  assertion: z.string().min(1).nullable(),
  kind: VerificationKindSchema.nullable(),
});
export type SourceCriterion = z.infer<typeof SourceCriterionSchema>;

export const SourceContractSchema = z.strictObject({
  source: ContractSourceSchema,
  /** `owner/repo#N` for a pull request; null when the flags supplied the contract. */
  reference: z.string().min(1).nullable(),
  url: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  outcome: z.string().min(1),
  outcome_from: OutcomeOriginSchema,
  /** Empty exactly when the source stated none. Never filled in from elsewhere. */
  criteria: z.array(SourceCriterionSchema),
});
export type SourceContract = z.infer<typeof SourceContractSchema>;

/** The id the outcome is judged under when a source states no criteria. */
export const OUTCOME_CRITERION_ID = "ac_outcome";

/**
 * What the outcome-only review asks of the change. Fixed text, deliberately:
 * it is the question the criterion-less case always asks, not a description of
 * this change that something had to make up.
 */
export const OUTCOME_CRITERION_ASSERTION = "the change achieves the stated outcome";

/** `text :: assertion [:: kind]`, the separator `perbo admit --criterion` uses. */
const CRITERION_SEPARATOR = " :: ";

export class SourceContractError extends Error {}

/**
 * One criterion as typed or as written in a list item.
 *
 * The ` :: ` convention is `admit`'s, so a person who knows one knows the
 * other — with one difference that belongs to review rather than to admission:
 * the assertion may be left out. `admit` refuses a criterion nothing can prove
 * because it is approving a plan; review is judging a change somebody else
 * already wrote, and refusing to read their criterion would not improve it.
 */
export function parseSourceCriterion(raw: string, index: number): SourceCriterion {
  const parts = raw.split(CRITERION_SEPARATOR);
  if (parts.length > 3) {
    throw new SourceContractError(
      `criterion ${index + 1} contains ${parts.length - 1} ' :: ' separators, so which part is ` +
        "the assertion is ambiguous. Use one (text :: assertion) or two (text :: assertion :: kind)",
    );
  }
  const [rawText, rawAssertion, rawKind] = parts.map((part) => part.trim());
  const { id, text } = splitLeadingId(rawText ?? "", index);
  if (!text) throw new SourceContractError(`criterion ${index + 1} is empty`);
  if (rawKind !== undefined && !(VerificationKindSchema.options as readonly string[]).includes(rawKind)) {
    throw new SourceContractError(
      `criterion ${index + 1} names verification kind '${rawKind}'; it must be one of ` +
        `${VerificationKindSchema.options.join(", ")}`,
    );
  }
  return SourceCriterionSchema.parse({
    id,
    text,
    assertion: rawAssertion === undefined || rawAssertion === "" ? null : rawAssertion,
    kind: rawKind === undefined || rawKind === "" ? null : (rawKind as VerificationKind),
  });
}

/**
 * `ac_3: the token is single use` keeps the id its author gave it. Anything
 * else is numbered by position, which is the only id a reader could match.
 */
function splitLeadingId(raw: string, index: number): { id: string; text: string } {
  const match = /^(ac_[0-9A-Za-z][0-9A-Za-z_-]{0,31})\s*[:.)\]-]\s+(.*)$/s.exec(raw);
  if (match) return { id: match[1]!, text: match[2]!.trim() };
  return { id: `ac_${index + 1}`, text: raw.trim() };
}

export interface PullRequestSource {
  /** `owner/repo#N`. */
  reference: string;
  title: string;
  /** External text. Never an instruction, wherever it is shown to a model. */
  body: string;
  url?: string | null;
}

/** A heading, a list item, or prose — Markdown as this reading needs it. */
interface Block {
  kind: "heading" | "item" | "prose";
  text: string;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
/** `**Outcome**` is a heading in bodies people actually write. */
const BOLD_HEADING = /^\s*\*\*(.+?)\*\*:?\s*$/;
/**
 * `Outcome:` and `Outcome: the thing` — a heading only when the label is one.
 * A bold label closes its emphasis on either side of the colon, because people
 * write both `**Outcome:** the thing` and `**Outcome**: the thing`.
 */
const LABEL_HEADING = /^\s{0,3}(\*\*)?([A-Za-z][A-Za-z ]{0,40})(?:\*\*)?:\s*(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/**
 * A line with its HTML comments removed, and whether one is still open.
 *
 * A pull request body is Markdown, and in Markdown an HTML comment is not
 * shown: GitHub's own pull request template is comments, so most bodies people
 * open contain text nobody reading the pull request can see. Taking it as the
 * contract would be wrong twice over — the outcome would be the template's
 * instructions to the author rather than anything the author wrote, and text
 * that is invisible to every human reviewer would be the thing the change is
 * judged against, which is the shape an injected instruction wants.
 *
 * CommonMark's two rules, which are also what the renderer applies. A comment
 * that opens its own line is an HTML block: it runs to the line carrying `-->`
 * or, failing that, to the end of the body. A comment that opens mid-line is
 * raw HTML inside a paragraph, so it is a comment only if something closes it
 * — here or on a later line; a `<!--` that nothing ever closes is not a
 * comment at all, renders as the literal text it is, and is left alone.
 */
function stripComments(
  line: string,
  open: boolean,
  closesLater: boolean,
): { text: string; open: boolean } {
  let rest = line;
  let text = "";
  let commented = open;
  for (;;) {
    if (commented) {
      const close = rest.indexOf(COMMENT_CLOSE);
      if (close === -1) return { text, open: true };
      rest = rest.slice(close + COMMENT_CLOSE.length);
      commented = false;
      continue;
    }
    const start = rest.indexOf(COMMENT_OPEN);
    if (start === -1) return { text: text + rest, open: false };
    const before = rest.slice(0, start);
    const after = rest.slice(start + COMMENT_OPEN.length);
    if (!after.includes(COMMENT_CLOSE)) {
      const blockForm = /^\s{0,3}$/.test(text + before);
      return blockForm || closesLater
        ? { text: text + before, open: true }
        : { text: text + rest, open: false };
    }
    text += before;
    rest = after;
    commented = true;
  }
}

/**
 * The body as blocks, ignoring fenced code and HTML comments. A `# Outcome`
 * inside a fenced example is an example, and a criteria list quoted in a code
 * block is not the pull request's criteria.
 *
 * `isSectionName` is what keeps the `Label: text` form from eating prose: only
 * a label this reading actually looks for opens a section, so `Fixes: #91` in
 * the middle of an outcome stays part of the outcome.
 */
function blocksOf(body: string, isSectionName: (name: string) => boolean): Block[] {
  const blocks: Block[] = [];
  let fenced = false;
  let commented = false;
  let item: string | null = null;
  let prose: string[] = [];

  const flushProse = () => {
    const text = prose.join(" ").trim();
    if (text) blocks.push({ kind: "prose", text });
    prose = [];
  };
  const flushItem = () => {
    if (item !== null) {
      const text = item.trim();
      if (text) blocks.push({ kind: "item", text });
    }
    item = null;
  };

  const lines = body.split(/\r?\n/);
  // Whether a comment's closer appears after each line, which is what decides
  // a `<!--` in the middle of one: raw HTML that nothing ever closes is text.
  const closesLater: boolean[] = new Array(lines.length).fill(false);
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    closesLater[index] = closesLater[index + 1]! || lines[index + 1]!.includes(COMMENT_CLOSE);
  }

  for (const [index, line] of lines.entries()) {
    // A comment is read before the fence test, because a fence inside hidden
    // text is hidden too — and only outside a fence, because a comment shown
    // as an example in a code block is the example's, not the body's. A line
    // left empty by its comment falls through to the blank-line branch below,
    // which is what an HTML block does to the paragraph around it.
    let raw = line;
    if (!fenced) {
      const stripped = stripComments(line, commented, closesLater[index]!);
      raw = stripped.text;
      commented = stripped.open;
    }
    if (FENCE.test(raw)) {
      fenced = !fenced;
      flushItem();
      flushProse();
      continue;
    }
    if (fenced) continue;

    const heading = HEADING.exec(raw) ?? BOLD_HEADING.exec(raw);
    if (heading) {
      flushItem();
      flushProse();
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
      continue;
    }
    const label = LABEL_HEADING.exec(raw);
    if (label && isSectionName(normalise(label[2]!))) {
      flushItem();
      flushProse();
      blocks.push({ kind: "heading", text: label[2]!.trim() });
      // `**Outcome:** the thing` closes the label's emphasis after the colon,
      // and those two asterisks belong to the label rather than to the outcome.
      const rest = (label[1] ? label[3]!.replace(/^\*\*/, "") : label[3]!).trim();
      if (rest) blocks.push({ kind: "prose", text: rest });
      continue;
    }
    const listItem = LIST_ITEM.exec(raw);
    if (listItem) {
      flushItem();
      flushProse();
      item = listItem[1]!;
      continue;
    }
    if (raw.trim() === "") {
      flushItem();
      flushProse();
      continue;
    }
    // An indented line under a list item continues it; anything else is prose.
    if (item !== null && /^\s+\S/.test(raw)) {
      item += ` ${raw.trim()}`;
      continue;
    }
    flushItem();
    prose.push(raw.trim());
  }
  flushItem();
  flushProse();
  return blocks;
}

const normalise = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const OUTCOME_HEADINGS = new Set(["outcome", "outcomes"]);
const CRITERIA_HEADINGS = new Set([
  "acceptance criteria",
  "acceptance criterion",
  "criteria",
  "criterion",
]);

/**
 * The contract a pull request states, and nothing more than it states.
 *
 * The outcome is the section headed `Outcome` where there is one, the first
 * paragraph of the body where there is not, and the title where the body is
 * empty — recorded as `stated`, `first_paragraph` or `title` so the bundle
 * says which. The criteria are the list under a heading that names them, and
 * there are none when no such heading exists: a body full of checkboxes under
 * "Todo" is a todo list, not a contract.
 */
export function sourceContractFromPullRequest(pull: PullRequestSource): SourceContract {
  const blocks = blocksOf(
    pull.body ?? "",
    (name) => OUTCOME_HEADINGS.has(name) || CRITERIA_HEADINGS.has(name),
  );

  let section: string | null = null;
  const outcomeParts: string[] = [];
  const criteriaLines: string[] = [];
  let firstParagraph: string | null = null;

  for (const block of blocks) {
    if (block.kind === "heading") {
      section = normalise(block.text);
      continue;
    }
    if (section !== null && OUTCOME_HEADINGS.has(section) && block.kind === "prose") {
      outcomeParts.push(block.text);
      continue;
    }
    if (section !== null && CRITERIA_HEADINGS.has(section) && block.kind === "item") {
      criteriaLines.push(block.text);
      continue;
    }
    if (firstParagraph === null && block.kind === "prose") firstParagraph = block.text;
  }

  const stated = outcomeParts.join(" ").trim();
  const outcome = stated || firstParagraph?.trim() || pull.title.trim();
  const outcome_from: OutcomeOrigin = stated
    ? "stated"
    : firstParagraph
      ? "first_paragraph"
      : "title";

  return SourceContractSchema.parse({
    source: "pull_request",
    reference: pull.reference,
    url: pull.url ?? null,
    title: pull.title,
    outcome,
    outcome_from,
    criteria: criteriaLines.map((line, index) => parseSourceCriterion(line, index)),
  });
}

/** The contract as typed: `--outcome` with any number of `--criterion`. */
export function sourceContractFromArguments(args: {
  outcome: string;
  criteria: readonly string[];
}): SourceContract {
  return SourceContractSchema.parse({
    source: "arguments",
    reference: null,
    url: null,
    title: null,
    outcome: args.outcome.trim(),
    outcome_from: "argument",
    criteria: args.criteria.map((raw, index) => parseSourceCriterion(raw, index)),
  });
}

/** An identifier segment that survives `plan_`/`ticket_`/`repo_`'s own shape. */
function slug(parts: readonly string[], limit = 48): string {
  const joined = parts
    .join("_")
    .replace(/[^0-9A-Za-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = joined.slice(0, limit).replace(/_+$/, "");
  return trimmed === "" || !/^[0-9A-Za-z]/.test(trimmed) ? `x${trimmed}` : trimmed;
}

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** `owner/repo#N` → its three parts, or null when it is not that shape. */
export function parsePullRequestReference(
  reference: string,
): { owner: string; repo: string; number: number } | null {
  const match = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/**
 * The identity a source contract mints its ids from: the pull request it was
 * read out of, or a digest of the outcome that was typed.
 *
 * Exported because a local run needs the same string for more than the plan
 * id. The loop labels a run — the branch, the commit message, the seed the
 * attempt ids are minted from — and with nothing admitted there is no ticket
 * key to label it with, so it is labelled by where its contract came from. One
 * function, so the label and the plan id cannot drift apart.
 */
export function sourceIdentity(contract: SourceContract): string {
  const reference = contract.reference ? parsePullRequestReference(contract.reference) : null;
  return reference
    ? slug(["gh", reference.owner, reference.repo, String(reference.number)])
    : slug(["local", digest(contract.outcome).slice(0, 12)]);
}

export interface PlanFromSourceInput {
  contract: SourceContract;
  base_commit: string;
  /** The identity of the checkout the review reads from. */
  repository_id: string;
  paths_allowed: readonly string[];
  paths_prohibited?: readonly string[];
  generated_paths?: readonly string[];
  expansion_budget_files?: number;
  captured_at: Date;
}

/**
 * The plan the reviewer actually runs on, minted from what a source stated.
 *
 * Two things here are worth being explicit about, because both are places
 * where an implementation could quietly invent a contract:
 *
 * **The criterion-less case.** A `PlanContract` cannot carry zero criteria, and
 * that is not an accident of the schema — a plan with nothing to prove is not a
 * plan. So the outcome itself becomes the one thing judged, under the reserved
 * id `ac_outcome` and with a fixed assertion. The reviewer is asked exactly the
 * question the source supports ("does this change achieve this outcome") and
 * nothing is added to it; the bundle keeps `criteria: []`, which is what a
 * reader is shown.
 *
 * **The scope.** A source contract states no paths, so the caller passes the
 * scope in: `**` where nobody said, which makes every file in the change in
 * scope. Deriving a scope from the files the change happens to touch would make
 * the scope check tautological — it would pass by construction, always.
 */
export function planContractFromSource(input: PlanFromSourceInput): PlanContractWithCriteria {
  const { contract } = input;
  const identity = sourceIdentity(contract);

  const criteria =
    contract.criteria.length > 0
      ? contract.criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          expected_verification: {
            kind: criterion.kind ?? "test",
            // Stated where the source stated one. Where it did not, the
            // criterion text is what must be proven and it is repeated here
            // rather than a proof being made up for it.
            assertion: criterion.assertion ?? criterion.text,
          },
        }))
      : [
          {
            id: OUTCOME_CRITERION_ID,
            text: contract.outcome,
            expected_verification: {
              kind: "test" as VerificationKind,
              assertion: OUTCOME_CRITERION_ASSERTION,
            },
          },
        ];

  const parsed = PlanContractSchema.parse({
    plan_id: `plan_${identity}`,
    version: 1,
    // No ticket was admitted. The id names where the contract came from, which
    // is the only true answer available: the pull request, or this outcome.
    ticket_id: `ticket_${identity}`,
    level: "P1",
    outcome: contract.outcome,
    acceptance_criteria: criteria,
    scope: {
      repository_id: input.repository_id,
      paths_allowed: [...input.paths_allowed],
      paths_prohibited: [...(input.paths_prohibited ?? [])],
      generated_paths: [...(input.generated_paths ?? [])],
      expansion_budget_files: input.expansion_budget_files ?? 0,
    },
    base: {
      base_commit: CommitShaSchema.parse(input.base_commit),
      // The context this plan was minted from is the source contract itself,
      // so the hash is over exactly that and is reproducible from the bundle.
      context_manifest_hash: `sha256:${digest(JSON.stringify(contract))}`,
      captured_at: input.captured_at.toISOString(),
    },
  });
  // `level: "P1"` is a literal above, so this is a type narrowing rather than a
  // check that can fail at runtime.
  if (parsed.level === "P0") throw new SourceContractError("a minted plan is never P0");
  return parsed;
}

/** Whether the source stated any criteria at all — SCP-179's distinction. */
export const statesCriteria = (contract: SourceContract): boolean => contract.criteria.length > 0;
