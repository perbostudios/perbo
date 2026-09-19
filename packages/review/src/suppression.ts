import { z } from "zod";
import { WaiverSchema, type Waiver } from "@perbo/contracts";
import { RULE_DEMOTION_FALSE_POSITIVE_RATE } from "./blocking.js";

/**
 * Per-rule, per-repository suppression, and rule authority earned or lost
 * through measurement (SCP-083, D-010).
 *
 * These are two different mechanisms and the difference is the point. A waiver
 * is a human saying "not here, not now", with an expiry and a name against it.
 * Demotion is the evaluation harness measuring that a rule cries wolf. The
 * escape hatch is the waiver; the mechanism is demotion. A rule that keeps
 * being wrong should lose standing without anyone having to mute it in
 * frustration.
 */

export const MAX_SUPPRESSION_DAYS = 90;

export const SuppressionFileSchema = z.union([
  z.array(WaiverSchema),
  z.strictObject({ suppressions: z.array(WaiverSchema) }).transform((value) => value.suppressions),
]);

export interface SuppressionLookup {
  find(rule_id: string, repository_id: string): Waiver | null;
  /** Waivers rejected on load, with the reason. Surfaced rather than dropped. */
  rejected: Array<{ waiver: Waiver; reason: string }>;
}

export function buildSuppressions(waivers: Waiver[], now: Date): SuppressionLookup {
  const active = new Map<string, Waiver>();
  const rejected: Array<{ waiver: Waiver; reason: string }> = [];

  for (const waiver of waivers) {
    const granted = new Date(waiver.granted_at).getTime();
    const expires = new Date(waiver.expires_at).getTime();
    if (expires <= now.getTime()) {
      rejected.push({ waiver, reason: `expired at ${waiver.expires_at}` });
      continue;
    }
    const days = (expires - granted) / 86_400_000;
    if (days > MAX_SUPPRESSION_DAYS) {
      rejected.push({
        waiver,
        reason: `spans ${Math.round(days)} days, above the ${MAX_SUPPRESSION_DAYS}-day maximum`,
      });
      continue;
    }
    active.set(`${waiver.rule_id}|${waiver.repository_id}`, waiver);
  }

  return {
    find: (rule_id, repository_id) => active.get(`${rule_id}|${repository_id}`) ?? null,
    rejected,
  };
}

export const RuleAuthorityFileSchema = z.strictObject({
  /** Which corpus run measured these rates, so a stale file is visible. */
  measured_at: z.iso.datetime(),
  measured_over_fixtures: z.number().int().min(1),
  rules: z.record(
    z.string(),
    z.strictObject({
      false_positive_rate: z.number().min(0).max(1),
      raised: z.number().int().min(0),
      false: z.number().int().min(0),
    }),
  ),
});
export type RuleAuthorityFile = z.infer<typeof RuleAuthorityFileSchema>;

export interface RuleAuthority {
  demoted(rule_id: string): boolean;
}

export const NO_MEASUREMENTS: RuleAuthority = { demoted: () => false };

/**
 * A rule is demoted when the harness has measured it raising findings on clean
 * changes at or above the demotion rate. Absence of a measurement is not
 * demotion — a rule that has never been measured keeps its authority.
 */
export function buildRuleAuthority(file: RuleAuthorityFile): RuleAuthority {
  return {
    demoted: (rule_id) => {
      const measured = file.rules[rule_id];
      if (!measured) return false;
      return measured.false_positive_rate >= RULE_DEMOTION_FALSE_POSITIVE_RATE;
    },
  };
}
