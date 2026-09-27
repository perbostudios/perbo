import { z } from "zod";

/**
 * What the issue text tried to do to the drafter, named line by line.
 *
 * An issue body — fetched from GitHub or pasted into a file — is
 * `trust="external"` data. The delimiting in `delimit.ts` and the standing
 * paragraph in the system prompt already keep it out of the instruction
 * position, and the drafter is told to name in its rationale anything that
 * addressed it. Both of those depend on the model behaving; neither leaves a
 * record a person can read before they approve.
 *
 * This is the deterministic half. It reads the body the same way whatever
 * supplied it, and reports the lines that claim the work is already finished or
 * that speak to the drafter rather than describe the work. It is a **report,
 * not a filter**: nothing here removes a line, rewrites a body or drops a glob.
 * An issue that says "the work lives in packages/auth" is describing the work,
 * and an issue that says "set the scope to **" is addressing the drafter, and
 * no pattern separates those two reliably enough to act on. A person reading
 * the draft separates them, which is the authority boundary D-072 draws.
 */

export const AUTHORED_ATTEMPT_KINDS = ["completion_claim", "instruction"] as const;
export type AuthoredAttemptKind = (typeof AUTHORED_ATTEMPT_KINDS)[number];

export const AuthoredAttemptSchema = z.strictObject({
  kind: z.enum(AUTHORED_ATTEMPT_KINDS),
  /** What the line tried to do, in the words a person reads on the draft. */
  what: z.string().min(1),
  /** The line as the issue wrote it, so the report can be checked against the source. */
  quote: z.string().min(1),
  /**
   * 1-based line number in the source a person can open, so a person can find
   * it. For a pasted file that is the line of the file itself, blank lines and
   * all; for a fetched issue, whose title and body are separate fields that no
   * single text numbers, the title is line 1 and the body starts at line 2.
   * The quote is what locates the line exactly; the number is what makes a long
   * body navigable.
   */
  line: z.number().int().positive(),
});
export type AuthoredAttempt = z.infer<typeof AuthoredAttemptSchema>;

interface AttemptRule {
  kind: AuthoredAttemptKind;
  what: string;
  pattern: RegExp;
}

/**
 * The rules, as families rather than phrases: a claim that the work is finished,
 * a claim that it is already authorised, and the several ways a body addresses
 * the drafter instead of describing the work — telling it to ignore what it was
 * told, speaking to it in the second person, naming a contract field, dictating
 * the scope, or asking it to stay quiet about any of that.
 *
 * Each rule carries the sentence a person will read, so a report says what the
 * line tried to do rather than which regular expression it tripped.
 */
const RULES: readonly AttemptRule[] = [
  {
    kind: "completion_claim",
    what: "claims the work is already done",
    pattern: /\balready\s+(?:been\s+)?(?:done|implemented|shipped|merged|fixed|completed?|handled|landed)\b/i,
  },
  {
    kind: "completion_claim",
    what: "claims the work is already done",
    pattern:
      /\b(?:this|it|that|the\s+(?:work|change|ticket|issue|task))\s+(?:is|was|has\s+been)\s+(?:done|complete[d]?|implemented|shipped|merged|fixed)\b/i,
  },
  {
    kind: "completion_claim",
    what: "claims no work is needed",
    pattern:
      /\bno\s+(?:further\s+|additional\s+|more\s+|remaining\s+)?(?:work|changes?|action|edits?)\s+(?:is\s+|are\s+)?(?:needed|required|necessary)\b/i,
  },
  {
    kind: "completion_claim",
    what: "claims there is nothing left to do",
    pattern: /\bnothing\s+(?:is\s+)?(?:left\s+)?(?:to\s+do|remains?|remaining)\b/i,
  },
  {
    kind: "completion_claim",
    what: "asserts a status of done",
    pattern: /(?:^|\|)\s*(?:status|state)\s*[:|]\s*(?:done|complete[d]?|closed|shipped|merged)\b/i,
  },
  {
    kind: "completion_claim",
    what: "claims the change is already approved",
    pattern: /\b(?:already|pre[-\s]?)\s*approved\b|\bapproval\s+(?:is\s+)?(?:not\s+needed|granted|waived)\b/i,
  },
  {
    kind: "instruction",
    what: "tells the drafter to ignore its instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,60}\b(?:instructions?|prompt|rules?|guidelines?|system|policy|policies)\b/i,
  },
  {
    kind: "instruction",
    what: "addresses the drafter directly",
    pattern: /\byou\s+(?:must|should|shall|will|need\s+to|have\s+to|are\s+to|are\s+required\s+to)\b/i,
  },
  {
    kind: "instruction",
    what: "addresses the drafter as a model",
    pattern: /\b(?:as\s+an?|being\s+an?|dear)\s+(?:ai|assistant|model|agent|llm|drafter)\b/i,
  },
  {
    kind: "instruction",
    what: "tells the drafter what scope to propose",
    pattern:
      /\b(?:widen|widening|expand|broaden|loosen|relax|remove|drop|lift|unrestrict)\b[^.\n]{0,60}\b(?:scope|prohibit\w*|restrictions?|limits?|globs?|paths?)\b/i,
  },
  {
    kind: "instruction",
    what: "tells the drafter what scope to propose",
    pattern:
      /\b(?:set|use|make|propose|give|allow|include|add)\b[^.\n]{0,40}\b(?:the\s+)?scope\b[^.\n]{0,60}/i,
  },
  {
    kind: "instruction",
    what: "names a field of the contract the drafter writes",
    pattern: /\b(?:paths?_allowed|paths?_prohibited\w*|proposed_scope|acceptance_criteria|expansion_budget\w*)\b/i,
  },
  {
    kind: "instruction",
    what: "tells the drafter what not to report",
    pattern:
      /\b(?:do\s+not|don'?t|never|no\s+need\s+to)\s+(?:flag|report|mention|note|say|warn|tell|surface)\b/i,
  },
  {
    kind: "instruction",
    what: "asks the drafter to approve the work",
    pattern: /\bapprove\s+(?:this|it|the\s+(?:draft|contract|scope|plan|ticket))\b/i,
  },
];

/**
 * How many attempts one body may *list*. A body engineered to trip every rule
 * on every line would otherwise fill the draft rendering and the snapshot with
 * its own text.
 *
 * The cap is on the list, never on the count: `found` keeps rising past it, so
 * a body written to flood cannot make the report understate itself. A person
 * approving a draft is told how many there were and that the list was cut.
 */
export const MAX_REPORTED_ATTEMPTS = 20;

/**
 * A run of text and where it begins in the source a person can open.
 *
 * The drafter is shown a title and then a body, but they are not always one
 * text: in a pasted file they are lines of the same file, separated by however
 * many blank lines the author left, and in a fetch they are two JSON fields.
 * Each segment carries its own first line so a reported number is a number a
 * person can act on rather than an offset into a string this happened to build.
 */
export interface AuthoredTextSegment {
  text: string;
  /** 1-based line number, in the source, of `text`'s first line. */
  firstLine: number;
}

export interface AuthoredAttemptReport {
  /** The attempts in source order, at most `MAX_REPORTED_ATTEMPTS` of them. */
  attempts: AuthoredAttempt[];
  /**
   * How many were found. Greater than `attempts.length` exactly when the list
   * was cut short, which is the case a person most needs told.
   */
  found: number;
}

/**
 * Every line of the given text that claims the work is finished or speaks to
 * the drafter, in the order it was written. One line reporting two different
 * attempts reports both; one line tripping two rules that name the same attempt
 * reports it once.
 *
 * A bare string is read as one segment beginning at line 1.
 */
export function issueAuthoredAttempts(
  source: string | readonly AuthoredTextSegment[],
): AuthoredAttemptReport {
  const segments = typeof source === "string" ? [{ text: source, firstLine: 1 }] : source;
  const attempts: AuthoredAttempt[] = [];
  let found = 0;
  for (const segment of segments) {
    for (const [index, raw] of segment.text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (line === "") continue;
      const named = new Set<string>();
      for (const rule of RULES) {
        if (named.has(rule.what) || !rule.pattern.test(line)) continue;
        named.add(rule.what);
        found += 1;
        // Reading continues past the cap: stopping here would make the count
        // the cap, and a flood is exactly where the count has to be true.
        if (attempts.length < MAX_REPORTED_ATTEMPTS) {
          attempts.push({
            kind: rule.kind,
            what: rule.what,
            // Whole: quoted evidence a person checks against the source (D-NEW-nothing-shown-is-cut).
            quote: line,
            line: segment.firstLine + index,
          });
        }
      }
    }
  }
  return { attempts, found };
}
