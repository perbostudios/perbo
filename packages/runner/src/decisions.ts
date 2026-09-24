import type { DecisionChoice, Finding, ReviewArtifact } from "@perbo/contracts";

/**
 * A person's answer to a finding the review routed to them, and how it is
 * recorded on the finding (D-NEW-a-person-s-answer-closes-a-routed-finding).
 */

/** Whether a choice hands the finding to the executor. */
export const handsToExecutor = (choice: DecisionChoice): boolean => choice !== "ship_as_is";

/**
 * A person's answer to one finding the review routed to them, as `perbo
 * verdict --decide` records it and `perbo run` hands it to the loop
 * (D-NEW-a-person-s-answer-closes-a-routed-finding).
 */
export interface DecidedFinding {
  finding_key: string;
  choice: DecisionChoice;
  /**
   * The review the person named when deciding, where they named one by its id;
   * null where they named the ticket or its pull request. A decision naming a
   * review answers that review and no other.
   */
  review_id: string | null;
  /** The person's words. Data about the finding, never an instruction to anything. */
  note: string;
  /** Who decided, as the verdicts record names them. */
  author: string;
  decided_at: string;
}

/**
 * How long a decision's waiver runs: the longest waiver the reviewer's own
 * suppressions accept (`MAX_SUPPRESSION_DAYS` in `@perbo/review`). The
 * decision is about one finding of one review, and the waiver says who took it
 * and in what words; the expiry only keeps it inside the schema's bounds.
 */
const DECISION_WAIVER_DAYS = 90;

/**
 * How a waiver a person's decision wrote is told from a per-rule suppression:
 * its audit id is the finding's key under this prefix.
 */
const DECIDED_AUDIT_PREFIX = "decided_";

/** Whether a finding carries a person's decision rather than a suppression. */
export function isDecided(finding: Finding): boolean {
  return finding.waiver !== null && finding.waiver.audit_id.startsWith(DECIDED_AUDIT_PREFIX);
}

/**
 * The review with each decided finding recorded as decided, on the finding
 * itself: no longer blocking, and a waiver naming who decided and in their
 * words. A finding shipped as it is is waived; one the executor closed as the
 * person decided is resolved and fixed, and only a caller that saw the round's
 * verification close it passes it here. The words are redacted where they
 * leave the run: once, and counted, in the pull request (D-063).
 */
export function recordDecisions(
  review: ReviewArtifact,
  decisions: ReadonlyMap<string, DecidedFinding>,
  repository_id: string,
): ReviewArtifact {
  if (decisions.size === 0) return review;
  return {
    ...review,
    findings: review.findings.map((finding) => {
      const decision = decisions.get(finding.key);
      if (decision === undefined) return finding;
      const granted = new Date(decision.decided_at);
      const shipped = decision.choice === "ship_as_is";
      return {
        ...finding,
        blocking: false,
        blocking_reason: shipped
          ? "waived: a person decided to ship it as it is"
          : "closed: the executor closed it as a person decided, and a verification confirmed it",
        routing: "waived" as const,
        status: shipped ? ("waived" as const) : ("resolved" as const),
        outcome: shipped ? ("waived" as const) : ("fixed" as const),
        waiver: {
          rule_id: finding.rule_id,
          repository_id,
          authorised_by: decision.author,
          granted_at: granted.toISOString(),
          expires_at: new Date(granted.getTime() + DECISION_WAIVER_DAYS * 86_400_000).toISOString(),
          reason: decision.note,
          audit_id: `${DECIDED_AUDIT_PREFIX}${finding.key}`,
        },
      };
    }),
  };
}

