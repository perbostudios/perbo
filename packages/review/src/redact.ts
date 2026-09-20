import { redactCredentials, type ReviewArtifact } from "@perbo/contracts";

/**
 * Redaction at the artifact boundary (D-063, SCP-109).
 *
 * A reviewer that correctly reports a committed credential **discloses it in
 * the process** — quoting the line that violates a criterion, or naming a key
 * while recommending rotation. Twelve reviews over four secret-bearing
 * fixtures leaked 6 of 6 on the channels where nothing but the model's
 * judgement protects the value, and 0 of 6 where a mechanism does. This is the
 * mechanism, applied to everything the reviewer writes.
 *
 * **It is a mechanism and not an instruction on purpose.** The prompt also asks
 * the reviewer to cite by location rather than content, which reduces how often
 * this has to fire — but discretion is what failed 6 of 6, so it is the second
 * line and not the first.
 *
 * The walk is deep and covers every string in the artifact rather than a list
 * of fields, because the leak channels measured were spread across three
 * different ones (`findings[].statement`, `coverage[].evidence.assertion`, and
 * a check summary) and a list would have to be right about a fourth nobody has
 * seen yet. What protects identifiers is `REDACTION_SKIPPED_KEYS` below plus
 * the detector's own narrowness — it requires a vendor prefix, credentials in a
 * URL, a PEM header, a JWT, or a long value bound to a secret-named
 * identifier, and it excludes bare digests, UUIDs and ULIDs explicitly.
 */

/**
 * Keys whose values must survive byte-exact, whatever they contain.
 *
 * These are matched by **content addressing or equality** somewhere downstream:
 * a finding `key` is the sha256 that closure verification uses to match routed
 * work, and mangling one silently unroutes it. A commit sha is checked out. An
 * id is compared. None of them can hold a credential in a form the detector
 * would fire on anyway, so skipping them costs no coverage.
 */
export const REDACTION_SKIPPED_KEYS: readonly string[] = [
  "key",
  "review_id",
  "resumed_from",
  "plan_id",
  "criterion_id",
  "check_id",
  "rule_id",
  "id",
  "base_commit",
  "head_commit",
  "schema_version",
  "prompt_version",
  "model_id",
  "provider",
  "created_at",
  "addressed_finding_keys",
  "responds_to_review_id",
];

export interface ArtifactRedaction {
  /** How many credential-shaped values were replaced. */
  count: number;
  /** Which detector rules fired, so a false positive is attributable to a rule. */
  rules: string[];
  /** Dotted paths that were rewritten, for the audit trail. */
  fields: string[];
}

export interface RedactedArtifact {
  artifact: ReviewArtifact;
  redactions: ArtifactRedaction;
}

const skipped = new Set(REDACTION_SKIPPED_KEYS);

/**
 * Replaces every credential-shaped value in the artifact with a marker that
 * keeps the vendor prefix — so "a Stripe live key is committed here" survives
 * — and removes the part that authenticates.
 *
 * The input is **not** mutated: the scorer needs the original to establish that
 * redaction fired where the secret would have been, which is what keeps the
 * corpus control falsifiable rather than vacuously green.
 */
export function redactReviewArtifact(artifact: ReviewArtifact): RedactedArtifact {
  const rules = new Set<string>();
  const fields: string[] = [];
  let count = 0;

  const walk = (value: unknown, path: string, key: string | null): unknown => {
    if (typeof value === "string") {
      if (key !== null && skipped.has(key)) return value;
      const redaction = redactCredentials(value);
      if (redaction.count === 0) return value;
      count += redaction.count;
      for (const rule of redaction.rules) rules.add(rule);
      fields.push(path);
      return redaction.text;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${path}[${index}]`, key));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [name, inner] of Object.entries(value)) {
        out[name] = walk(inner, path === "" ? name : `${path}.${name}`, name);
      }
      return out;
    }
    return value;
  };

  const redacted = walk(artifact, "", null) as ReviewArtifact;
  return { artifact: redacted, redactions: { count, rules: [...rules], fields } };
}
