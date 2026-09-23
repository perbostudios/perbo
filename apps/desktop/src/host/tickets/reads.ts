import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  CostRollSchema,
  CostSchema,
  PlanContractSchema,
  ReviewArtifactSchema,
  RunBundleSchema,
  TicketSchema,
  hasAcceptanceCriteria,
} from "@perbo/contracts";
import type { Ticket } from "@perbo/contracts";
import { assertionsChangedSinceDraft, readSpecText } from "@perbo/planning";
import { specFindings } from "../../shared/contract-editing.js";
import { judgingChecks } from "../../shared/checks.js";
import { redact, requireSuccess } from "../process.js";
import { listBundles, readAttempts, readDraftEditRecordsOrNone, summariseTicket } from "../records.js";
import type { BundleManifest } from "../records.js";
import { effectiveLimits } from "../repository/config.js";
import { attemptsPath, bundlesPath, objectsPath, principlesPath, ticketPath } from "../repository/layout.js";
import { specPath, ticketSpecSlug } from "../plan/spec.js";
import type { Cli } from "../cli.js";
import type { RepositoryRegistry } from "../repository/registry.js";
import type { WorkspaceReads } from "../workspace-reads.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Detail, ReplyMap, Settings, TaskSummary } from "../../shared/protocol.js";

const ListSchema = z.object({ tickets: z.array(TicketSchema) });
const CheckSchema = z
  .object({
    name: z.string().optional(),
    check_id: z.string().optional(),
    status: z.string(),
    summary: z.string().optional(),
    detail: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    output: z.unknown().optional(),
    /**
     * Present on a result the runner ran for one node of an execution graph
     * (D-107). The desktop shows what judges the change, which is the results
     * without it.
     */
    node: z.object({ node_id: z.string() }).passthrough().optional(),
  })
  .passthrough();
const ReportSchema = z
  .object({
    attempts: z.array(
      z
        .object({
          attempt_id: z.string(),
          run: z.number(),
          round: z.number(),
          started_at: z.string(),
          outcome: z.string(),
          termination: z
            .object({ reason: z.string(), detail: z.string() })
            .passthrough(),
          agent: z.object({ model: z.string() }).passthrough(),
          cost: CostSchema,
          ceilings: z.array(
            z.object({
              resource: z.string(),
              used: z.number().nullable(),
              // Null where nothing bounds the resource, which after D-096 is
              // most of them on most runs.
              ceiling: z.number().nullable(),
              hit: z.boolean(),
            }),
          ),
          review: ReviewArtifactSchema.nullable(),
          review_decision: z.string().nullable(),
          changed_files: z
            .array(
              z.object({
                path: z.string(),
                change_kind: z.string(),
                additions: z.number().nullable(),
                deletions: z.number().nullable(),
              }),
            )
            .nullable(),
          checks: z.array(CheckSchema).nullable(),
          verification: z.unknown(),
          bundles: z.array(RunBundleSchema),
        })
        .passthrough(),
    ),
    total_cost: CostRollSchema,
    verdicts: z.array(z.unknown()),
  })
  .passthrough();

export interface TicketReadsDeps {
  reads: WorkspaceReads;
  cli: Cli;
  registry: RepositoryRegistry;
  settings(): Settings;
}

/**
 * Everything this host reads of a repository's tickets, through the CLI that
 * owns the store and the records the runner wrote beside it.
 *
 * Each read is shared while it is in flight and invalidated when the records
 * move, under the key its repository and ticket give it, so five surfaces
 * asking at once run one command rather than five.
 */
export class TicketReads {
  private readonly deps: TicketReadsDeps;

  constructor(deps: TicketReadsDeps) {
    this.deps = deps;
  }

  /** Every ticket the repository's store holds. */
  list(repo: RegisteredRepository): Promise<z.infer<typeof ListSchema>> {
    return this.deps.reads.read("list:" + repo.id, repo.id, async () =>
      ListSchema.parse(
        JSON.parse(requireSuccess(await this.deps.cli.run(["list", "--all", "--json"], repo))),
      ),
    );
  }

  /** One ticket, or the sentence every surface says when the store no longer holds it. */
  async ticket(repo: RegisteredRepository, key: string): Promise<Ticket> {
    const ticket = (await this.list(repo)).tickets.find((entry) => entry.key === key);
    if (!ticket) throw new Error("This task is no longer in the repository's ticket store.");
    return ticket;
  }

  /** The contract as it stands, with the digest of the bytes it was read from. */
  contract(
    repo: RegisteredRepository,
    key: string,
  ): { contract: Detail["contract"]; digest: string } {
    const raw = readFileSync(ticketPath(repo, key, ".contract.json"), "utf8");
    return {
      contract: PlanContractSchema.parse(JSON.parse(raw)),
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  }

  /** What was shown is what is approved or edited: a contract that moved since refuses. */
  assertDigest(repo: RegisteredRepository, key: string, digest: string): void {
    if (this.contract(repo, key).digest !== digest)
      throw new Error(
        "The contract changed since you opened it. Refresh and review the latest version before approving or editing.",
      );
  }

  /** The bundles this repository sealed, read once for every surface that needs them. */
  bundles(repo: RegisteredRepository): Promise<BundleManifest[]> {
    return this.deps.reads.read("bundles:" + repo.id, repo.id, async () =>
      listBundles(bundlesPath(repo)),
    );
  }

  /** One repository's row on Home: what Git says about it, and the tickets it holds. */
  repositorySnapshot(repoId: string): Promise<ReplyMap["repositorySnapshot"]> {
    const repo = this.deps.registry.lookup(repoId);
    return this.deps.reads.read("repository:" + repoId, repoId, async () => {
      const [metadata, listing] = await Promise.allSettled([
        this.deps.registry.metadata(repo),
        this.list(repo),
      ]);
      if (metadata.status === "rejected") throw metadata.reason;
      const repository = metadata.value;
      try {
        if (repository.error) throw new Error(repository.error);
        if (listing.status === "rejected") throw listing.reason;
        const list = listing.value;
        return {
          repository,
          tasks: list.tickets.map((ticket) => ({
            repoId,
            repository: repo.name,
            ticket,
          })),
          errors: [],
        };
      } catch (error) {
        return {
          repository,
          tasks: [],
          errors: [`${repo.name}: ${redact(String(error))}`],
        };
      }
    });
  }

  detail(repoId: string, key: string): Promise<Detail> {
    return this.deps.reads.read("detail:" + repoId + ":" + key, repoId, () =>
      this.read(repoId, key),
    );
  }
  private async read(repoId: string, key: string): Promise<Detail> {
    const repo = this.deps.registry.lookup(repoId);
    const ticket = await this.ticket(repo, key);
    const report = ReportSchema.parse(
      JSON.parse(
        requireSuccess(await this.deps.cli.run(["inspect", key, "--json"], repo)),
      ),
    );
    const principles = principlesPath(repo);
    const limits = effectiveLimits(repo, this.deps.settings()).limits;
    const held = this.contract(repo, key);
    return {
      ticket,
      ...held,
      specFindings: readSpecFindings(repo, ticket, held.contract),
      // Read from the same records the plan's history is drawn from, so the two
      // can never disagree about which edits are in force.
      changedAssertions: assertionsChangedSinceDraft(
        readDraftEditRecordsOrNone(ticketPath(repo, key, ".draft.json")),
        hasAcceptanceCriteria(held.contract) ? held.contract.acceptance_criteria : [],
      ),
      attempts: report.attempts.map((attempt) => ({
        id: attempt.attempt_id,
        run: attempt.run,
        round: attempt.round,
        startedAt: attempt.started_at,
        outcome: attempt.outcome,
        termination: `${attempt.termination.reason}: ${attempt.termination.detail}`,
        model: attempt.agent.model,
        costMicros: attempt.cost.micros,
        costBasis: attempt.cost.basis,
        partial: attempt.cost.partial,
        ceilings: attempt.ceilings,
        review: attempt.review,
        reviewDecision: attempt.review_decision,
        changes: attempt.changed_files ?? [],
        checks: judgingChecks(attempt.checks ?? []).map((check) => ({
          name: check.name ?? check.check_id ?? "Check",
          status: check.status,
          detail: [
            check.command,
            check.summary,
            check.detail ??
              (check.output === undefined
                ? null
                : typeof check.output === "string"
                  ? check.output
                  : JSON.stringify(check.output, null, 2)),
          ]
            .filter(Boolean)
            .join("\n\n"),
        })),
        verification: attempt.verification,
        bundles: attempt.bundles,
      })),
      cost: {
        micros: report.total_cost.micros,
        partial:
          report.total_cost.partial > 0 || report.total_cost.unavailable > 0,
        unavailable: report.total_cost.unavailable,
      },
      principles: existsSync(principles)
        ? readFileSync(principles, "utf8").slice(0, 100_000)
        : "",
      verdicts: report.verdicts,
      effective: {
        stallMinutes: limits["attempt_stall_ms"]! / 60_000,
        ticketDollars: limits["ticket_cost_micros"]! / 1_000_000,
      },
      report,
    };
  }
  /** The row a ticket shows while it runs, from the records the loop wrote (SCP-317). */
  summary(repoId: string, key: string): Promise<TaskSummary> {
    return this.deps.reads.read(
      "summary:" + repoId + ":" + key,
      repoId,
      async () => {
        const repo = this.deps.registry.lookup(repoId);
        const ticket = await this.ticket(repo, key);
        const record = readAttempts(
          attemptsPath(repo, ticket.ticket_id),
        );
        const bundles = record.attempts.length ? await this.bundles(repo) : [];
        return summariseTicket({
          ticket,
          attempts: record.attempts,
          attemptsError: record.error,
          bundles,
          objectsDirectory: objectsPath(repo),
        });
      },
    );
  }
}

/**
 * Where this plan and the spec it was drafted from disagree, as
 * {@link specFindings} reads them off this ticket's spec file.
 *
 * A spec that cannot be read says nothing rather than everything: the whole
 * plan would otherwise read as dangling the moment the file moved.
 */
function readSpecFindings(
  repo: RegisteredRepository,
  ticket: Ticket,
  contract: Detail["contract"],
): Detail["specFindings"] {
  if (!hasAcceptanceCriteria(contract)) return [];
  let requirements;
  try {
    const slug = ticketSpecSlug(repo, ticket);
    if (slug === null) return [];
    requirements = readSpecText(specPath(repo, slug)).requirements;
  } catch {
    return [];
  }
  return specFindings(requirements, contract.acceptance_criteria);
}
