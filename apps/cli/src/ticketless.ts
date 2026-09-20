import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  AuthoredAttemptSchema,
  CriterionEvidenceBindingSchema,
  FindingSchema,
  GithubCredentialSchema,
  PlanContractSchema,
  ReviewArtifactSchema,
  ReviewDecisionSchema,
  ReviewRouteSchema,
  SourceContractSchema,
  issueAuthoredAttempts,
  planContractFromSource,
  redactCredentials,
  parsePullRequestReference,
  routeForReview,
  sourceContractFromArguments,
  sourceContractFromPullRequest,
  statesCriteria,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type ReviewRouting,
  type SourceContract,
} from "@perbo/contracts";
import { isRemediableFamily, remediableFindings } from "@perbo/review";
import type { ReviewArgs } from "./args.js";
import { UsageError } from "./usage-error.js";
import { readPullRequest, readRefRange, type GitRunner, type PullRequestRead } from "./pull-request.js";

/**
 * Reviewing a change nobody admitted (SCP-179).
 *
 * `perbo review --contract c.json --diff change.diff` is the review step with
 * a plan already approved behind it. This is the same step with nothing behind
 * it: the contract is read from the pull request the change is already
 * described in, or typed on the command line, the diff comes from `gh` or from
 * `git`, and the verdict, the findings and the routing decision are written
 * into the repository's own `.perbo/`. Nothing is sent anywhere. The only
 * thing that leaves this machine is the read of the pull request, and only when
 * one was named.
 */

/** What was reviewed, pinned. Every commit here is a commit, never a ref name. */
export const ReviewTargetSchema = z.strictObject({
  kind: z.enum(["pull_request", "ref_range"]),
  reference: z.string().min(1).nullable(),
  url: z.string().min(1).nullable(),
  head_ref: z.string().min(1),
  base_ref: z.string().min(1),
  head_commit: z.string().min(1),
  base_commit: z.string().min(1),
  /** True when `base_commit` is where the two refs diverged, not the base ref. */
  merge_base: z.boolean(),
  /**
   * SCP-200: which credential path the pull request was read through. Null for
   * a ref range, which reads no GitHub at all, and on a bundle written before
   * the field existed. The path, never the token.
   */
  github_credential: GithubCredentialSchema.nullable().default(null),
  /**
   * SCP-211: `owner/name` of the repository `head_commit` was read from. It is
   * the fork for a pull request opened from one and the pull request's own
   * repository otherwise, so the head-to-head's fork route is a recorded fact
   * about each review rather than something inferred from the reference. Null
   * for a ref range, and on a bundle written before the field existed.
   */
  head_repository: z.string().min(1).nullable().default(null),
  /**
   * Which repository the head was looked up in, as a class: a fork of the
   * repository the pull request is open on, or that repository itself. Recorded
   * beside the name because the two names can coincide — a fork keeps its
   * upstream's name unless the forker changes it.
   */
  head_lookup: z.enum(["fork", "same_repository"]).nullable().default(null),
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const TICKETLESS_BUNDLE_SCHEMA_VERSION = 1;

/**
 * The review bundle: what was judged, against what, and where it goes next.
 *
 * The artifact is carried whole, and the three things a person actually acts on
 * — the verdict, the findings and the routing — are also at the top level,
 * because a bundle that makes you walk into a nested document to find out who
 * has the change next is a bundle nobody reads.
 */
export const TicketlessReviewBundleSchema = z.strictObject({
  schema_version: z.literal(TICKETLESS_BUNDLE_SCHEMA_VERSION),
  review_id: z.string().min(1),
  created_at: z.iso.datetime(),
  /** The contract as its source stated it. `criteria: []` means none stated. */
  contract: SourceContractSchema,
  /** The plan minted from that contract, which is what the reviewer was given. */
  plan: PlanContractSchema,
  target: ReviewTargetSchema,
  decision: ReviewDecisionSchema,
  routing: z.strictObject({ decision: ReviewRouteSchema, reason: z.string().min(1) }),
  coverage: z.array(CriterionEvidenceBindingSchema),
  findings: z.array(FindingSchema),
  /**
   * Lines of the pull request's own text that claim the work is done or address
   * whoever is reading it. A pull request body is written by whoever opened it,
   * and this command turns it into the one thing the reviewer treats as the
   * plan — so what it tried is recorded beside the verdict it may have aimed at.
   */
  external_text_attempts: z.array(AuthoredAttemptSchema),
  artifact: ReviewArtifactSchema,
  /** The reviewer's turn-by-turn record, when one was kept. */
  run: z.unknown().optional(),
});
export type TicketlessReviewBundle = z.infer<typeof TicketlessReviewBundleSchema>;

export interface TicketlessSource {
  contract: SourceContract;
  plan: PlanContractWithCriteria;
  diff: string;
  target: ReviewTarget;
  external_text_attempts: TicketlessReviewBundle["external_text_attempts"];
}

/** `repo_<something>`: the identity of what is being reviewed, not a secret. */
function repositoryId(pull: PullRequestRead | null, repoDir: string): string {
  const parts = pull
    ? (() => {
        const reference = parsePullRequestReference(pull.reference);
        return reference ? [reference.owner, reference.repo] : [pull.reference];
      })()
    : [basename(resolve(repoDir)) || "repository"];
  const slug = parts
    .join("_")
    .replace(/[^0-9A-Za-z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `repo_${/^[0-9A-Za-z]/.test(slug) ? slug : `x${slug}`}`;
}

export interface ResolveInput {
  args: ReviewArgs;
  cwd: string;
  now: Date;
  /** The pull-request read. Production uses `gh`; a test may point at another binary. */
  gh?: { binary?: string | undefined } | undefined;
  git?: GitRunner | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * The contract, the diff and the two commits, from whichever source was named.
 *
 * A contract comes from exactly one source: the pull request, or the flags. A
 * `--criterion` typed beside a pull request that states its own is refused
 * rather than merged with it — a half-typed contract judged as if it were the
 * author's is the failure this whole command is built to avoid.
 */
export async function resolveTicketlessSource(input: ResolveInput): Promise<TicketlessSource> {
  const { args } = input;
  const repoDir = resolve(input.cwd, args.repo);

  const pull = args.pr
    ? await readPullRequest(args.pr, { ...(input.gh?.binary ? { binary: input.gh.binary } : {}), cwd: repoDir })
    : null;
  if (pull) input.onProgress?.(`read ${pull.reference}: ${pull.title}`);
  // SCP-211: which repository the head came from, said out loud when it is not
  // the one the reference names. A review of a fork's commit is a different
  // read from a review of a branch of the repository itself.
  if (pull?.head_lookup === "fork") {
    input.onProgress?.(`head commit ${pull.head_commit} read from the fork ${pull.head_repository}`);
  }

  const range =
    pull === null && args.base !== null
      ? readRefRange({
          repo: repoDir,
          head: args.head!,
          base: args.base,
          ...(input.git ? { git: input.git } : {}),
        })
      : null;

  const contract =
    args.outcome !== null
      ? sourceContractFromArguments({ outcome: args.outcome, criteria: args.criteria })
      : sourceContractFromPullRequest({
          reference: pull!.reference,
          title: pull!.title,
          body: pull!.body,
          url: pull!.url,
        });

  const target: ReviewTarget = pull
    ? {
        kind: "pull_request",
        reference: pull.reference,
        url: pull.url,
        head_ref: pull.head_ref,
        base_ref: pull.base_ref,
        head_commit: pull.head_commit,
        base_commit: pull.base_commit,
        merge_base: false,
        github_credential: pull.github_credential,
        head_repository: pull.head_repository,
        head_lookup: pull.head_lookup,
      }
    : {
        kind: "ref_range",
        reference: null,
        url: null,
        head_ref: range!.head_ref,
        base_ref: range!.base_ref,
        head_commit: range!.head_commit,
        base_commit: range!.base_commit,
        merge_base: range!.merge_base,
        github_credential: null,
        head_repository: null,
        head_lookup: null,
      };

  const plan = planContractFromSource({
    contract,
    base_commit: target.base_commit,
    repository_id: repositoryId(pull, repoDir),
    paths_allowed: args.paths.length > 0 ? args.paths : ["**"],
    captured_at: input.now,
  });

  // The pull request's text is the one place external prose becomes the plan.
  // What in it addressed the reader is reported, never removed: the reviewer
  // still judges the change, and a person reading the bundle sees the attempt.
  const external = pull
    ? issueAuthoredAttempts([
        { text: pull.title, firstLine: 1 },
        { text: pull.body, firstLine: 2 },
      ])
    : { attempts: [], found: 0 };

  return {
    contract,
    plan,
    diff: pull ? pull.diff : range!.diff,
    target,
    external_text_attempts: external.attempts,
  };
}

/** The routing this review's verdict produces, with the reason it produced it. */
export function routingFor(artifact: ReviewArtifact): ReviewRouting {
  return routeForReview({
    decision: artifact.decision,
    remediable_findings: remediableFindings(artifact.findings).filter((finding) =>
      isRemediableFamily(finding.rule_id),
    ).length,
  });
}

export function buildTicketlessBundle(input: {
  source: TicketlessSource;
  artifact: ReviewArtifact;
  routing: ReviewRouting;
  run?: unknown;
}): TicketlessReviewBundle {
  return TicketlessReviewBundleSchema.parse({
    schema_version: TICKETLESS_BUNDLE_SCHEMA_VERSION,
    review_id: input.artifact.review_id,
    created_at: input.artifact.created_at,
    contract: input.source.contract,
    plan: input.source.plan,
    target: input.source.target,
    decision: input.artifact.decision,
    routing: input.routing,
    coverage: input.artifact.coverage,
    findings: input.artifact.findings,
    external_text_attempts: input.source.external_text_attempts,
    artifact: input.artifact,
    ...(input.run === undefined ? {} : { run: input.run }),
  });
}

/** `<store>/reviews/` — the local store, and the only place this run writes. */
export function reviewsDir(cwd: string, args: ReviewArgs): string {
  const repoDir = resolve(cwd, args.repo);
  return args.store ? resolve(cwd, args.store, "reviews") : join(repoDir, ".perbo", "reviews");
}

/**
 * Write the bundle into the local store. Redacted as text like every other
 * document this command produces (D-063): a pull request body is repository
 * content, and repository content has held credentials before.
 */
export function writeTicketlessBundle(
  dir: string,
  bundle: TicketlessReviewBundle,
): { path: string; redactions: number } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${bundle.review_id}.review.json`);
  const redacted = redactCredentials(JSON.stringify(bundle, null, 2));
  writeFileSync(path, `${redacted.text}\n`);
  return { path, redactions: redacted.count };
}

/** Refuse the combinations that would produce a contract nobody wrote. */
export function assertTicketlessArgs(args: ReviewArgs): void {
  if (args.pr !== null && (args.base !== null || args.head !== null)) {
    throw new UsageError(
      "--pr already names both commits; --head and --base compare two refs instead. Use one.",
    );
  }
  if (args.base !== null && args.head === null) {
    throw new UsageError("--base needs --head: a range has two ends");
  }
  if (args.outcome === null && args.criteria.length > 0) {
    throw new UsageError(
      "--criterion needs --outcome: a contract comes from one source, so criteria typed beside a " +
        "pull request that states its own would be neither the author's nor yours",
    );
  }
  if (args.pr === null && args.base === null) {
    throw new UsageError(
      "--outcome reviews a change: name it with --pr <owner/repo#N> or --head <ref> --base <ref>",
    );
  }
  if (args.outcome === null && args.pr === null) {
    throw new UsageError(
      "--head --base carries no contract with it: add --outcome \"...\" (and --criterion where " +
        "there are criteria), or review a pull request with --pr, which states its own",
    );
  }
  for (const [flag, value] of [
    ["--contract", args.contract],
    ["--diff", args.diff],
    ["--resume", args.resume],
  ] as const) {
    if (value !== null) {
      throw new UsageError(
        `${flag} cannot be combined with a ticketless review: the contract and the diff come from ` +
          "the pull request or the arguments",
      );
    }
  }
}

export { statesCriteria };
