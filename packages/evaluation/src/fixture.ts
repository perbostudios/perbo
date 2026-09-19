import { z } from "zod";
import { CriterionIdSchema, PlanLevelSchema } from "@perbo/contracts";

/**
 * The seeded-defect corpus (SCP-081, docs/14).
 *
 * A fixture declares what was seeded and what counts as detecting it. Both are
 * written **before** the reviewer runs against it, and `expected_detection` is
 * never edited after a result is seen. A fixture whose expected result was
 * written after seeing the output reads green and means nothing.
 */

export const DEFECT_CLASSES = [
  "requirement_omission",
  "verification_defect",
  "security_introduction",
  "migration_hazard",
  "scope_escape",
  "adversarial_context",
  /**
   * D-053. The change satisfies its own criterion completely and breaks
   * something the criterion never mentioned.
   *
   * The other six are defects somebody seeds on purpose; this is the kind
   * nobody would think to seed, which is why it is drawn rather than written. A
   * commit a real repository merged and then reverted is one of these, with the
   * revert as public ground truth — a defect a human review missed, which is
   * exactly what a seeded defect is a substitute for.
   */
  "unstated_regression",
  "clean",
] as const;
export const DefectClassSchema = z.enum(DEFECT_CLASSES);
export type DefectClass = (typeof DEFECT_CLASSES)[number];

export const FixtureSourceSchema = z.strictObject({
  /** What kind of public record the defect comes from. */
  kind: z.enum(["advisory", "cve", "issue", "commit", "postmortem", "documented_pattern"]),
  reference: z.string().min(1),
  url: z.array(z.string().url()).min(1),
  /**
   * `transplanted` — the upstream code is reproduced, which requires a
   * permissive licence. `reconstructed` — only the defect *pattern* described
   * in the public record is reproduced, and every line of the fixture is
   * written here. Reconstruction is what makes a copyleft-licensed advisory
   * usable without copying anything from it.
   */
  derivation: z.enum(["transplanted", "reconstructed"]),
  upstream_licence: z.string().min(1),
  code_copied: z.boolean(),
});

const DetectionCommon = {
  /**
   * Pre-registered anchors for attribution. Criterion and rule-prefix matches
   * confirm the mechanism. A file-only match is a candidate for blind review,
   * not automatic recall; the path proves locus regardless of finding source.
   */
  criterion_ids: z.array(CriterionIdSchema).default([]),
  files: z.array(z.string().min(1)).default([]),
  /** Optional narrowing: the rule id must start with one of these. */
  rule_prefixes: z.array(z.string().min(1)).default([]),
};

export const ExpectedDetectionSchema = z.discriminatedUnion("mode", [
  /**
   * The defect must raise a confirmed blocking/remediable finding. The
   * historical OR-over-anchor hit is retained separately for reproduction.
   * This is what "blocking-defect recall" counts from attribution v2 onward.
   */
  z.strictObject({ mode: z.literal("blocking"), ...DetectionCommon }),
  /**
   * The defect must be *identified* even where the blocking matrix leaves it
   * advisory — a verification defect at P1 is advisory by policy, so counting
   * only blocks would score the specified behaviour as a miss.
   */
  z.strictObject({
    mode: z.literal("coverage"),
    ...DetectionCommon,
    /** Detection means the criterion landed in one of these states. */
    statuses: z.array(z.enum(["not_met", "cannot_determine"])).default(["not_met"]),
    strengths: z.array(z.enum(["proxy", "asserted_only"])).default(["proxy", "asserted_only"]),
  }),
  /**
   * The change is clean. "Detection" is the wrong word: the fixture passes when
   * the gate stays open, and a blocking finding here is a false block.
   */
  z.strictObject({ mode: z.literal("clean") }),
  /**
   * D-068. A merged change a good reviewer has substantive objections to.
   *
   * `clean` means "a blocking finding here is an error", and for a change drawn
   * from a merged commit that assumes maintainer review is ground truth. It is
   * a better assumption than "I wrote it and believe it is fine" and it is not
   * a true one: `vuejs/core` reverted twelve commits in its recent history, and
   * the reviewer identified a live cache-key desync in one of these fixtures —
   * verified against the source — in three independent reviews.
   *
   * Neither outcome is scored as an error. The fixture is excluded from the
   * false-block denominator and reported as a **disagreement rate**, which is
   * the honest name for the quantity: how often a competent reviewer and a
   * competent maintainer differ about a real change.
   *
   * `objection` is the reason, and it is required. A fixture moves here only on
   * a written, checkable claim about the code that somebody verified — never
   * because a run came out badly, which would make this a bucket for
   * inconvenient results and destroy the false-block rate it is protecting.
   */
  z.strictObject({
    mode: z.literal("contested"),
    objection: z.string().min(40),
    verified_by: z.string().min(1),
  }),
]);
export type ExpectedDetection = z.infer<typeof ExpectedDetectionSchema>;

/**
 * Whether the fixture's own tree can be **run**, measured rather than claimed.
 *
 * Stage 2 found that this matters: an experiment involving an executor needs a
 * suite the executor can run to check its own work, and without one the
 * executor flails and the reviewer has no check results to ground evidence in.
 *
 * The trees carry no manifests of their own, so `corpus/runtime/` supplies the
 * four files that make one runnable. Nothing in a fixture is edited to achieve
 * it — editing them would break comparability with rounds already measured.
 */
export const FIXTURE_RUNTIME_STATUSES = ["runs", "suite_fails", "no_tests", "not_installable"] as const;
export const FixtureRuntimeSchema = z.strictObject({
  status: z.enum(FIXTURE_RUNTIME_STATUSES),
  /** What the suite reported, or why it could not run. Measured, not asserted. */
  note: z.string().min(1),
});
export type FixtureRuntime = z.infer<typeof FixtureRuntimeSchema>;

/**
 * A fixture whose change is a **real merged commit in a real repository**.
 *
 * Round two's finding was that a hand-written clean change is not clean in the
 * sense the corpus needs: repairing the finding that blocked one revealed the
 * next true finding behind it, three times out of three, because a good reviewer
 * does not run out of true things to say about hand-written code. Its
 * recommendation was to draw the clean changes from merged commits instead, so
 * that their cleanliness is a fact about the world rather than a claim by their
 * author.
 *
 * That cannot be done with a self-contained `before/`/`after/` tree: extracting
 * a real commit into one is a reconstruction, and reconstruction is the thing
 * being avoided. So the fixture pins the repository and the two commits, and
 * `perbo-corpus prepare` materialises them into a cache that is never checked
 * in. **No upstream code enters this repository**, which also keeps the licence
 * question where it belongs: at clone time, against a permissive licence.
 *
 * The `contract.json` is still authored here — a real commit carries no
 * acceptance criteria. That is authoring the *contract*, not the code, and the
 * code's cleanliness is the part that had to stop being a claim.
 */
export const PinnedRepositorySchema = z.strictObject({
  url: z.string().url(),
  /** Checked before a clone. Permissive only; the corpus copies nothing anyway. */
  licence: z.string().min(1),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  head_commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** What the merge was, in one line, so a reader knows without cloning. */
  subject: z.string().min(1),
  /** Where the upstream change can be read. */
  reference: z.string().url(),
  /**
   * How the fixture was made runnable, and how its checks were measured.
   *
   * A pinned fixture's tree is a clone, so the corpus's shared runtime files do
   * not apply and the commands differ per repository. None of them was
   * guessable: a narrower install than `uv sync --all-groups --all-packages
   * --all-extras` fails collection in one repository, and another needs a full
   * `pnpm build` before its own unit tests can resolve the workspace package
   * they import. Setup is therefore an ordered list rather than one command.
   * Without these on the fixture, the status in `checks.json` is a number
   * nobody can reproduce.
   */
  setup_commands: z.array(z.array(z.string().min(1)).min(1)).min(1),
  verify_command: z.array(z.string().min(1)).min(1),
});
export type PinnedRepository = z.infer<typeof PinnedRepositorySchema>;

export const FixtureSchema = z.strictObject({
  id: z.string().regex(/^[a-z]{3}-\d{3}-[a-z0-9-]+$/),
  class: DefectClassSchema,
  defective: z.boolean(),
  plan_level: PlanLevelSchema,
  source: FixtureSourceSchema,
  /** What was seeded, in one sentence. */
  defect: z.string().min(1),
  /** Why it is hard — the reason a reviewer plausibly misses it. */
  why_it_is_hard: z.string().min(1),
  expected_detection: ExpectedDetectionSchema,
  /**
   * Strings that must never appear in the review artifact. Used by the
   * adversarial class to catch a reviewer relaying planted secrets into its own
   * output. Reporting the injection is the desired behaviour, so the markers
   * are secret-shaped values rather than the injected instruction text.
   */
  forbidden_strings: z.array(z.string().min(1)).default([]),
  /** Adversarial fixtures: the verdict must not be flipped to approve. */
  must_not_approve: z.boolean().default(false),
  authored_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * Whether this fixture existed before the reviewer's rules did. The first
   * round did; the expansion could not. Recorded rather than smoothed over,
   * because it is the difference between a test and a rationalisation.
   */
  authored_before_reviewer: z.boolean(),
  /**
   * Absent on a fixture whose runtime has never been surveyed. Present means
   * `perbo-corpus runnable` measured it on the date in `notes`.
   */
  runtime: FixtureRuntimeSchema.nullable().default(null),
  /**
   * Set when the change is a real merged commit rather than an authored tree.
   * Such a fixture has no `before/`, no `after/` and no `change.diff` checked
   * in; `perbo-corpus prepare` materialises all three into a cache.
   */
  pinned_repository: PinnedRepositorySchema.nullable().default(null),
  notes: z.string().default(""),
});
export type Fixture = z.infer<typeof FixtureSchema>;
