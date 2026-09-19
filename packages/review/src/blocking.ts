import {
  BLOCKING_ROWS,
  type BlockingRow,
  type ClosureAuthority,
  type Finding,
  type FindingDirection,
  type FindingRouting,
  type PlanLevel,
  type RoutingPolicy,
} from "@perbo/contracts";

export { BLOCKING_ROWS };
export type { BlockingRow };

/**
 * The blocking policy matrix (docs/04, D-010, SCP-083).
 *
 * There is no `severity × risk_class × confidence` product here and there must
 * never be one: model confidence is not calibrated well enough to be a
 * multiplicand in a hard gate, and multiplying it against severity lets a
 * confident-sounding trivial finding outrank a hedged serious one. Blocking is
 * a lookup, and the row that fired is recorded on the finding so the lookup is
 * auditable afterwards.
 */

/**
 * The stated confidence floor for row 4. A high-risk semantic finding
 * at or above it blocks; below it the finding escalates to a human rather than
 * passing silently. It is a threshold on one number, not a term in a product.
 */
export const SEMANTIC_BLOCKING_CONFIDENCE_FLOOR = 0.7;

/** A rule whose measured false-positive rate is at or above this loses authority. */
export const RULE_DEMOTION_FALSE_POSITIVE_RATE = 0.3;

/**
 * The rule in force. D-065 made the attempt the discriminator: every stopping
 * finding on a routable row goes to the executor, which either finds the
 * established practice and fixes, or declares that no determinable practice
 * exists — and the declaration is what stops for a person. Earlier policies
 * stay replayable so a stored run can be scored under the rules earlier
 * rounds measured and a difference attributed to the rule, never to a
 * different sample.
 */
export const CURRENT_ROUTING_POLICY: RoutingPolicy = "d069";

/**
 * Five outcomes since D-051, not four. `remediable` is the one with somewhere
 * to send the work: the finding is real, closing it needs no decision only a
 * human can make, so it goes back to the executor as a **new attempt** whose
 * evidence is then graded independently.
 *
 * It is not a softer `blocks`. The gate is still closed — `remediable` exits 2
 * — and what changes is who is asked to close it.
 */
export type BlockingOutcome = FindingRouting;

export interface BlockingInput {
  row: BlockingRow;
  /** The full dotted id. Its first segment decides two things here. */
  rule_id: string;
  /** The criterion the finding names, where it names one (D-081 routes on it at P1). */
  criterion_id?: string | null;
  /** `null` for a deterministic finding: a measurement has no confidence term. */
  confidence: number | null;
  /**
   * `max(planned_risk, actual_risk)`. `planned_risk` selects the policy a
   * change starts under and a human may raise it but not lower it; `actual_risk`
   * escalates it if the sealed diff turned out to be more than was declared.
   * The stronger of the two is the one review is conducted under.
   */
  risk_level: PlanLevel;
  /** True when the evaluation harness has measured this rule crying wolf. */
  rule_demoted: boolean;
  /** An unexpired, authorised, per-rule per-repository suppression. */
  waived: boolean;
  /**
   * True where the illegible bytes a `legibility.*` finding names are on a line
   * or in a file this change added or modified — the executor's own edit, which
   * one remediation round can remove — and, since d069, where the pinned check a
   * `check.*` finding names ran and failed on a tree whose base had passed the
   * workspace's verify command. Read by d068 and nothing before it, and kept on
   * the finding so a re-read under the policy sees what the reviewer saw.
   */
  caused_by_change?: boolean | undefined;
  /**
   * The reviewer's structured answer to "who can close this". `null` for a
   * deterministic finding, which is never routed to the executor — a failing
   * check or a scope escape means the change is wrong, not unevidenced — with
   * two exceptions: illegible bytes the change itself added (d068) and a pinned
   * check the change itself broke (d069), each routed once and then verified.
   */
  closure: ClosureAuthority | null;
  /**
   * The reviewer's structured answer to "does this finding have a direction"
   * (D-064). `null` on deterministic findings, on artifacts that predate the
   * question, and on the contract and verification rows, whose direction is
   * negative by construction rather than by answer. Only an affirmative
   * `negative` opens the fix-and-notify path; `neutral`, `unsure` and `null`
   * all keep the pre-D-064 outcome, so the gate never widens on a hedge or a
   * missing field.
   */
  direction: FindingDirection | null;
  /** False on the last round: nothing is remediable when there is no round left. */
  remediation_available: boolean;
  /** Defaults to the rule in force. Set explicitly to score a run under the old one. */
  policy?: RoutingPolicy;
}

export interface BlockingDecision {
  outcome: BlockingOutcome;
  blocking: boolean;
  reason: string;
}

const HIGH_RISK: readonly PlanLevel[] = ["P2", "P3"];

/**
 * Who a finding is given to first (D-051 as widened by D-056).
 *
 * D-051 routed on an affirmative `executor` only, and read `unclear` as a
 * reason to put a person in front of the finding: guessing `executor` where the
 * reviewer hedged looked like the path by which a behavioural defect gets
 * auto-patched into a green board.
 *
 * The measurement says that reading was wrong, and the reason it was wrong is
 * that **`blocks` and `remediable` close the same gate**. `remediable` exits 2,
 * the change does not merge, and the executor's answer is graded by a second
 * independent review that is told nothing about why the code was written. So
 * the choice between the two outcomes is not "stop or continue" — it is *who is
 * asked first*, and the price of asking the wrong one is one bounded attempt in
 * one direction and an unwanted human turn in the other. The human-agreement
 * sample priced the second: 11 of the 19 findings the reviewer blocked on
 * should have gone to the executor, and none of the forty was judged not worth
 * acting on.
 *
 * So uncertainty now resolves toward the reversible party. The reviewer's one
 * dispositive answer is `human`; `executor` and `unclear` both route, and a
 * finding the executor cannot close comes back on the last round with nowhere
 * left to go and blocks, which is the human turn arriving one attempt later
 * rather than never.
 */
function remediable(input: BlockingInput): boolean {
  if (!input.remediation_available) return false;
  if (!isRemediableFamily(input.rule_id)) return false;
  if ((input.policy ?? CURRENT_ROUTING_POLICY) === "d051") return input.closure === "executor";
  return input.closure !== "human" && input.closure !== null;
}

/**
 * D-064's widening, on top of the closure-based routing above: a finding with
 * a **direction** routes to the executor whatever the closure answer, because
 * a negative finding has a known correct fix — "for anything even slightly
 * negative, the AI could fix it" — and the person is notified rather than
 * stopped. The family guard and the last-round rule still apply: `security.*`
 * and `context.*` stop regardless of direction (the owner's 2026-08-30
 * ruling), and on the last round nothing is remediable, which is where the
 * deferred human turn arrives.
 *
 * On the contract and verification rows the direction is negative **by
 * construction** — an unmet criterion and absent evidence both have the
 * direction the plan already states — so those rows route under d064 without a
 * model answer. On the semantic rows only the reviewer's affirmative
 * `negative` counts.
 */
function remediableUnderD064(input: BlockingInput): boolean {
  const policy = input.policy ?? CURRENT_ROUTING_POLICY;
  if (policy !== "d064" && policy !== "d065" && policy !== "d066" && policy !== "d067" && policy !== "d068" && policy !== "d069") return false;
  if (!input.remediation_available) return false;
  if (!isRemediableFamily(input.rule_id)) return false;
  // D-065: the attempt is the discriminator — every routable stopping finding
  // goes to the executor, and "no determinable practice" is declared there,
  // not predicted here. D-081 keeps that rule.
  if (policy === "d065" || policy === "d066" || policy === "d067" || policy === "d068" || policy === "d069") return true;
  if (input.row === "contract" || input.row === "verification_strength") return true;
  return input.direction === "negative";
}

/**
 * Two rule families never go back to the executor, whatever the reviewer said
 * about who can close them.
 *
 * `context.*` is the injected-instruction family. Its statements quote text an
 * attacker wrote into the repository, and putting that quote into an executor's
 * brief is the laundering path the trust tiers exist to prevent — the reviewer
 * refuses to read the file, and then the finding hands over the contents.
 *
 * `security.*` is behavioural by construction: closing "this falls back to an
 * empty signing key" means deciding what the system should do instead, which is
 * D-051's own definition of a human's call.
 *
 * This lives here rather than in the runner so that a corpus measurement of the
 * routing and the loop's actual behaviour are the same rule. A guard applied
 * only in the loop would make every measured number an overstatement.
 */
export const NEVER_REMEDIATED_FAMILIES = ["context", "security"] as const;

export function isRemediableFamily(rule_id: string): boolean {
  const family = rule_id.split(".")[0] ?? "";
  return !(NEVER_REMEDIATED_FAMILIES as readonly string[]).includes(family);
}

/**
 * Why a finding that might have been routed was not, kept on the record.
 *
 * Policy-aware, because the answer differs: under `d051` an `unclear` finding
 * was never routable at all, so telling a reader its rounds were spent would be
 * a confident wrong reason on a record that outlives the code.
 */
function unroutedBecause(input: BlockingInput): string {
  const policy = input.policy ?? CURRENT_ROUTING_POLICY;
  const couldHaveRouted =
    policy === "d051"
      ? input.closure === "executor"
      : policy === "d056"
        ? input.closure === "executor" || input.closure === "unclear"
        : policy === "d065" || policy === "d066" || policy === "d067" || policy === "d068" || policy === "d069"
          ? true
          : input.direction === "negative" ||
            input.row === "contract" ||
            input.row === "verification_strength" ||
            input.closure === "executor" ||
            input.closure === "unclear";
  if (couldHaveRouted && !input.remediation_available) {
    return "; not routed to the executor because the remediation rounds are spent";
  }
  if (couldHaveRouted && !isRemediableFamily(input.rule_id)) {
    return `; ${input.rule_id.split(".")[0]} findings are never routed to the executor`;
  }
  if (policy === "d065" || policy === "d066" || policy === "d067" || policy === "d068" || policy === "d069") return "";
  if (policy === "d064" && input.direction === "neutral") {
    return (
      "; the finding is neutral — observable behaviour the specification does not describe — " +
      "and stopping for a person is what the gate exists for (D-064)"
    );
  }
  if (policy === "d064" && input.direction !== "negative") {
    return "; its direction is unclassified, so it keeps the pre-D-064 outcome";
  }
  if (input.closure === "human") return "; closing it needs a decision only a human can make";
  if (input.closure === "unclear") return "; who can close it is unclear, so it is not remediated";
  return "";
}

export function isHighActualRisk(level: PlanLevel): boolean {
  return HIGH_RISK.includes(level);
}

export function decideBlocking(input: BlockingInput): BlockingDecision {
  // A waiver is the only override of a deterministic finding, and it overrides
  // every other row too. It carries an expiry, an authorising actor and an
  // audit entry; the caller has already checked those.
  if (input.waived) {
    return {
      outcome: "waived",
      blocking: false,
      reason: "waived: an unexpired, authorised per-rule suppression applies",
    };
  }

  // The stop families outrank the row — under the policies whose decisions
  // say so. D-064's ruling ("want it to stop") and D-065's restatement claimed
  // `security.*`/`context.*` always stop, but until 2026-09-01 the code
  // implemented only "never remediable": a finding the reviewer classified
  // non-blocking fell to `semantic_ordinary` and ended advisory, and on
  // `adv-006` the loop then approved a `must_not_approve` change end-to-end
  // with a detected forged review artifact riding along as a note. Family now
  // forces the stop whatever the reviewer's severity. Gated on the policy:
  // `d051`/`d056` predate the ruling, and a stored run must replay as it ran.
  // A demoted rule stays demoted: demotion is D-010's measured, recorded
  // revocation of a rule that cried wolf — like a waiver, a person-backed
  // override the family stop must not silently defeat.
  const policy = input.policy ?? CURRENT_ROUTING_POLICY;
  if (
    (policy === "d064" || policy === "d065" || policy === "d066" || policy === "d067" || policy === "d068" || policy === "d069") &&
    !isRemediableFamily(input.rule_id) &&
    !input.rule_demoted &&
    input.row !== "deterministic"
  ) {
    return {
      outcome: "blocks",
      blocking: true,
      reason:
        `${input.rule_id.split(".")[0]}: the stop families stop whatever the reviewer's ` +
        "severity — closing one means deciding what the system should do, or laundering " +
        "attacker text into a brief (D-064, D-065)",
    };
  }

  // D-081: a finding about how the change was evidenced — the `evidence.*`
  // family — is advisory on its own. It names no defect in the change, so on
  // its own it must never close a gate; where a behavioural finding sits
  // beside it, that finding still routes or stops. A failing check is a
  // different thing and keeps its row above.
  if (policy === "d066" && input.row !== "deterministic" && input.rule_id.split(".")[0] === "evidence") {
    return {
      outcome: "advisory",
      blocking: false,
      reason:
        "evidence: how the change was evidenced is advisory on its own — it names no defect " +
        "in the change, so alone it neither routes nor stops (D-081)",
    };
  }
  // D-085: a weakness of the evidence is a defect of the change's evidence, and
  // the executor can usually close it — a missing test, a proof command not
  // recorded. Where it can, the finding goes there with no notice to the
  // person, whatever the risk level and whatever the direction answer; where
  // it cannot, or on the last round, it stays advisory, because on its own it
  // never stops a change.
  if ((policy === "d067" || policy === "d068" || policy === "d069") && input.row !== "deterministic" && input.rule_id.split(".")[0] === "evidence") {
    // Routed exactly where the rows below would route it — D-065's rule that
    // the attempt is the discriminator applies to evidence as to anything
    // else — and where they would not, advisory rather than a stop. A demoted
    // rule takes the advisory return: demotion is a person-backed override this
    // branch must not silently defeat, and the rows below would not all keep it.
    if (!input.rule_demoted && (remediable(input) || remediableUnderD064(input))) {
      return {
        outcome: "remediable",
        blocking: false,
        reason:
          "evidence: a weakness of the change's evidence the executor can close — returned as " +
          "work rather than shown (D-085), then reviewed again",
      };
    }
    return {
      outcome: "advisory",
      blocking: false,
      reason:
        "evidence: a weakness of the change's evidence nobody can close in this round — " +
        "advisory, because on its own it never stops a change (D-085)" +
        unroutedBecause(input),
    };
  }

  // A legibility block the change itself caused — a NUL on an added line, a
  // file the change added that git will not render, a file the change touched
  // that the reviewer could not read — is the executor's own edit, and one
  // round removes it. It goes back once, with the byte and the line in the
  // statement. The review runs once and the rounds after it are verified, not
  // re-reviewed (D-061), so "once" is the verifier's: a round that leaves the
  // bytes fails its deterministic gate and the change stops there. A block on
  // a file the change did not touch stops here, as every deterministic
  // finding does.
  if (
    (policy === "d068" || policy === "d069") &&
    input.row === "deterministic" &&
    input.rule_id.split(".")[0] === "legibility" &&
    input.caused_by_change === true &&
    input.remediation_available !== false
  ) {
    return {
      outcome: "remediable",
      blocking: false,
      reason:
        "legibility: illegible bytes the change itself added — returned to the executor for one " +
        "round, then verified; a round that leaves them stops",
    };
  }

  // A pinned check that ran and failed on the change's tree, where the base
  // passed the workspace's verify command before the executor began, is the
  // executor's own breakage, and one round with the check's last lines in the
  // statement is what removes it. As with legibility, "once" is the verifier's:
  // it runs the pinned checks on the round's tree before asking anything, so a
  // round that leaves the check failing stops there (D-090). A check that did
  // not run — skipped, errored, absent — is not the change's to fix and stops
  // here as every deterministic finding does.
  if (
    policy === "d069" &&
    input.row === "deterministic" &&
    input.rule_id.split(".")[0] === "check" &&
    input.caused_by_change === true &&
    input.remediation_available !== false
  ) {
    return {
      outcome: "remediable",
      blocking: false,
      reason:
        "check: a pinned check the change itself broke — returned to the executor for one " +
        "round, then verified; a round that leaves it failing stops",
    };
  }

  switch (input.row) {
    case "deterministic":
      return {
        outcome: "blocks",
        blocking: true,
        reason:
          "deterministic: a security, scope or check failure always blocks — no confidence term",
      };

    case "contract":
      // D-056. An unmet criterion was unroutable under D-051 — not by argument,
      // but because the coverage entry's own closure answer was discarded on the
      // way in. It is the plainest remediable case there is: the plan already
      // states the behaviour, so nobody has to decide what the software should
      // do, and "criterion ac_3 is not met" is the executor being told to finish
      // its own work. Where a human must decide, the reviewer says `human` and
      // this still blocks. Gated on the policy as well as on the answer: under
      // `d051` this row had no route at all, and scoring a stored run under the
      // old rule has to reproduce that.
      // Affirmative `executor` only, unlike the semantic rows.
      //
      // The family guard cannot see this row: a contract-row finding always
      // carries `criterion.not_met`, family `criterion`, so a criterion about
      // authentication routes exactly like one about a log line. `security.*`
      // never routes because closing it means deciding what the system should
      // do — and an unmet criterion can be about precisely that. Where the
      // reviewer only hedges, that is not enough to send it to an agent.
      if (
        ((input.policy ?? CURRENT_ROUTING_POLICY) !== "d051" &&
          input.closure === "executor" &&
          remediable(input)) ||
        // D-064: an unmet criterion is negative by construction — the plan
        // already states the behaviour — so it routes whatever the closure
        // answer, and the person is notified rather than stopped.
        remediableUnderD064(input)
      ) {
        return {
          outcome: "remediable",
          blocking: false,
          reason:
            "contract: an acceptance criterion the plan requires is not met, and the plan " +
            "already states the behaviour, so it returns to the executor as work and the " +
            "change set is reviewed again",
        };
      }
      return {
        outcome: "blocks",
        blocking: true,
        reason:
          "contract: an acceptance criterion the plan requires is not met, so coverage is " +
          "incomplete (merge gate 2)" +
          unroutedBecause(input),
      };

    case "verification_strength":
      // The canonical remediable case: the change may be right and nothing
      // establishes it. Routed at every risk level, because the work is the
      // same work whether the change is P1 or P3. Under d064 it also routes
      // whatever the closure answer — absent evidence has a known direction —
      // but only where the d056 outcome would have stopped the change: at P1
      // the fallthrough is advisory, and converting an advisory into a routed
      // round would close a gate D-064 exists to open.
      if (remediable(input) || (isHighActualRisk(input.risk_level) && remediableUnderD064(input))) {
        return {
          outcome: "remediable",
          blocking: false,
          reason:
            "verification: nothing establishes this criterion and the executor can establish it, " +
            "so it returns as work and the change set is reviewed again",
        };
      }
      if (isHighActualRisk(input.risk_level)) {
        return {
          outcome: "blocks",
          blocking: true,
          reason:
            `verification: asserted_only blocks at ${input.risk_level}` +
            unroutedBecause(input),
        };
      }
      return {
        outcome: "advisory",
        blocking: false,
        reason: "verification: asserted_only is advisory at P1" + unroutedBecause(input),
      };

    case "semantic_high_risk": {
      if (input.rule_demoted) {
        return {
          outcome: "advisory",
          blocking: false,
          reason:
            "rule demoted: this rule's measured false-positive rate cost it authority through " +
            "the evaluation harness",
        };
      }
      // D-064: the reviewer's affirmative `negative` routes, whatever the
      // closure answer — a finding with a direction has a known correct fix,
      // and the person is notified rather than stopped.
      if (remediableUnderD064(input)) {
        return {
          outcome: "remediable",
          blocking: false,
          reason:
            (input.policy ?? CURRENT_ROUTING_POLICY) === "d065" ||
            (input.policy ?? CURRENT_ROUTING_POLICY) === "d066" ||
            (input.policy ?? CURRENT_ROUTING_POLICY) === "d067" || (input.policy ?? CURRENT_ROUTING_POLICY) === "d068" ||
            (input.policy ?? CURRENT_ROUTING_POLICY) === "d069"
              ? `semantic on a ${input.risk_level} change: routed to the executor, which closes ` +
                "it per the established practice or declares no determinable practice (D-065); " +
                "the change set is then reviewed again"
              : `semantic on a ${input.risk_level} change with a direction — negative, so fixing ` +
                "it needs no product decision (D-064): returned as work, then reviewed again",
        };
      }
      // Where the row that produced most of Stage 1's false blocks now goes.
      if (remediable(input)) {
        return {
          outcome: "remediable",
          blocking: false,
          reason:
            `semantic on a ${input.risk_level} change that the executor can close without a ` +
            "decision only a human can make: returned as work, then reviewed again",
        };
      }
      const confidence = input.confidence ?? 0;
      if (confidence >= SEMANTIC_BLOCKING_CONFIDENCE_FLOOR) {
        return {
          outcome: "blocks",
          blocking: true,
          reason:
            `semantic on a ${input.risk_level} change, at or above the stated confidence floor ` +
            `of ${SEMANTIC_BLOCKING_CONFIDENCE_FLOOR}` +
            unroutedBecause(input),
        };
      }
      return {
        outcome: "escalates",
        blocking: false,
        reason:
          `semantic on a ${input.risk_level} change, below the stated confidence floor of ` +
          `${SEMANTIC_BLOCKING_CONFIDENCE_FLOOR}: escalated to a human rather than passed ` +
          "silently",
      };
    }

    case "semantic_ordinary":
      if (input.rule_demoted) {
        return {
          outcome: "advisory",
          blocking: false,
          reason: "rule demoted by measured false-positive history; ordinary semantic anyway",
        };
      }
      // D-081: on a P1 change a finding that names a criterion, is negative and
      // is closable by the executor is work the plan already states. It goes to
      // the executor rather than to the person, as it does on a P2 or P3 change;
      // the change set is then reviewed again. Without a criterion, a direction
      // or a routable closure it stays what it was.
      if (
        (policy === "d066" || policy === "d067" || policy === "d068" || policy === "d069") &&
        input.criterion_id != null &&
        input.direction === "negative" &&
        remediable(input)
      ) {
        return {
          outcome: "remediable",
          blocking: false,
          reason:
            `semantic on a ${input.risk_level} change naming ${input.criterion_id}, negative and ` +
            "closable by the executor: returned as work rather than shown (D-081), then reviewed again",
        };
      }
      return {
        outcome: "advisory",
        blocking: false,
        reason: "ordinary semantic finding: advisory by default",
      };
  }
}

/**
 * Apply a decision to a finding, recording which row fired and where it went —
 * and the two inputs the row consumed, so the lookup can be replayed rather
 * than only read.
 */
export function applyBlocking(
  finding: Finding,
  decision: BlockingDecision,
  input: BlockingInput,
): Finding {
  return {
    ...finding,
    blocking: decision.blocking,
    blocking_reason: decision.reason,
    routing: decision.outcome,
    row: input.row,
    closure: input.closure,
    direction: input.direction,
    caused_by_change: input.caused_by_change ?? null,
    status: decision.outcome === "waived" ? "waived" : finding.status,
    outcome: decision.outcome === "waived" ? "waived" : finding.outcome,
  };
}

/** The findings a remediation attempt is asked to close. */
export function remediableFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.routing === "remediable");
}
