import { existsSync, readFileSync } from "node:fs";
import {
  ApproachRecordSchema,
  hasAcceptanceCriteria,
  planNodes,
  planSizeCounts,
  sizeEstimate,
} from "@perbo/contracts";
import type { GraphEdge, PlanContract, Ticket } from "@perbo/contracts";
import type { PlanNode } from "@perbo/contracts";
import { liveGraph, readAttempts, readDecisions, readDraftEdits } from "../records.js";
import { attemptsPath, objectsPath, ticketPath, verdictsPath } from "../repository/layout.js";
import { safePath } from "../repository/paths.js";
import { trackedFiles, type Execute } from "../repository/git.js";
import type { TicketReads } from "../tickets/reads.js";
import type { RegisteredRepository } from "../profile/store.js";
import type {
  GraphCriterionView,
  GraphLiveView,
  GraphNodeView,
  GraphView,
} from "../../shared/protocol.js";

/** What reading a plan's graph needs of the rest of the host. */
export interface GraphDeps {
  tickets: Pick<TicketReads, "ticket" | "contract" | "bundles">;
  execute: Execute;
}

/**
 * The approach record beside a ticket: the order between its nodes and the
 * spec's No-Gos (D-100). A plan that has never had a graph has none, which is
 * an empty order rather than a failure; a record that does not parse, or that
 * belongs to another plan, is a refusal, because showing a graph with the
 * wrong order is worse than showing none.
 */
function readApproach(
  repo: RegisteredRepository,
  key: string,
  contract: PlanContract,
): GraphEdge[] {
  const path = ticketPath(repo, key, ".approach.json");
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = ApproachRecordSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `${key}'s approach record could not be read as an order between its nodes. Restore it from version control.`,
    );
  if (parsed.data.plan_id !== contract.plan_id || parsed.data.ticket_id !== contract.ticket_id)
    throw new Error(
      `${key}'s approach record belongs to another plan. Restore it from version control.`,
    );
  return [...parsed.data.edges];
}

/**
 * The generated page of each node, read from the spec folder (D-103). Absent
 * for a ticket drafted from an issue, which has no spec to generate from, and
 * for a node whose page has not been written yet.
 */
function nodePages(
  repo: RegisteredRepository,
  ticket: Ticket,
  nodes: readonly { id: string }[],
): Map<string, { path: string; text: string }> {
  const pages = new Map<string, { path: string; text: string }>();
  const spec = ticket.admission.spec;
  if (spec === null) return pages;
  const folder = spec.path.split("/").slice(0, -1).join("/");
  for (const node of nodes) {
    const path = `${folder}/nodes/${node.id}.md`;
    let full: string;
    try {
      full = safePath(repo, ...path.split("/"));
    } catch {
      // A symlink on the way is a page the pane does not show, not a refusal of the graph.
      continue;
    }
    if (!existsSync(full)) continue;
    pages.set(node.id, { path, text: readFileSync(full, "utf8") });
  }
  return pages;
}

/**
 * One plan's execution graph as the Graph pane reads it (D-100, D-104): the
 * contract's nodes and criteria, the approach's order, the size over the
 * repository's tracked files, and the log of every edit with its author.
 *
 * Read from the store the CLI writes, never from anything the pane holds:
 * the pane's every edit goes back through `perbo edit`, so this is the only
 * account of what the plan now is. The tracked files stay on this side: the
 * size is counted here, and a listing crosses only through the explorer,
 * which withholds what nothing reads.
 */
export async function graphView(
  deps: GraphDeps,
  repo: RegisteredRepository,
  key: string,
): Promise<GraphView> {
  const ticket = await deps.tickets.ticket(repo, key);
  const { contract, digest } = deps.tickets.contract(repo, key);
  const criteria: GraphCriterionView[] = hasAcceptanceCriteria(contract)
    ? contract.acceptance_criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        kind: criterion.expected_verification.kind,
        assertion: criterion.expected_verification.assertion,
        requirement: criterion.requirement_id ?? null,
        manual:
          criterion.expected_verification.kind === "manual"
            ? {
                reviewer: criterion.expected_verification.manual_reviewer ?? "",
                reason: criterion.expected_verification.manual_reason ?? "",
              }
            : null,
      }))
    : [];
  const held = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const nodes = planNodes(contract);
  const pages = nodePages(repo, ticket, nodes);
  const files = await trackedFiles(deps.execute, repo.path);
  return {
    key,
    state: ticket.state,
    approved: ticket.approved_at !== null,
    outcome: contract.outcome,
    nodes: nodes.map(
      (node): GraphNodeView => ({
        id: node.id,
        title: node.title,
        criteria: node.criteria.flatMap((id) => {
          const criterion = held.get(id);
          return criterion ? [criterion] : [];
        }),
        paths: [...node.paths],
        page: pages.get(node.id) ?? null,
      }),
    ),
    criteria,
    edges: readApproach(repo, key, contract),
    pathsAllowed: [...contract.scope.paths_allowed],
    size: sizeEstimate(
      planSizeCounts({
        nodes,
        criteria: criteria.length,
        paths_allowed: contract.scope.paths_allowed,
        paths_prohibited: contract.scope.paths_prohibited,
        trackedFiles: files,
      }),
    ),
    editCount: ticket.admission.edit_count ?? 0,
    history: readDraftEdits(ticketPath(repo, key, ".draft.json")),
    digest,
    live: await liveView(deps, repo, ticket, nodes),
  };
}

/**
 * What this ticket's own records say about its graph (SCP-317): the sealed
 * change set, the pinned checks narrowed to each node, and the review of
 * this plan with whatever the rounds since it closed.
 *
 * Read here rather than through `perbo inspect`, as `taskSummary` reads the
 * same store: the Graph pane is refreshed after every edit and while a run
 * moves, and this is a read of files the loop already wrote — no job, no
 * write and no subprocess.
 */
async function liveView(
  deps: GraphDeps,
  repo: RegisteredRepository,
  ticket: Ticket,
  nodes: readonly PlanNode[],
): Promise<GraphLiveView> {
  const record = readAttempts(
    attemptsPath(repo, ticket.ticket_id),
  );
  const bundles = record.attempts.length ? await deps.tickets.bundles(repo) : [];
  return liveGraph({
    nodes: nodes.map((node) => ({ id: node.id, paths: node.paths, criteria: node.criteria })),
    attempts: record.attempts,
    bundles,
    ticketId: ticket.ticket_id,
    decisions: readDecisions(verdictsPath(repo), ticket.ticket_id),
    planVersion: ticket.plan_version,
    objectsDirectory: objectsPath(repo),
  });
}
