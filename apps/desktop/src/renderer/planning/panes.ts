import type { InkIconName } from "../ui/index.js";
import type { OpenDraft, PlanningPane, Snapshot } from "../../shared/protocol.js";
import type { Route } from "../shell/route.js";

/**
 * The panes planning mode has, in rail order, each by an id the protocol's
 * `PlanningPaneSchema` names. Each pane's ticket adds its entry here and
 * its id there; an id there with no entry here fails to compile, naming it.
 *
 * Second, under the spec it came from, is the plan — and which pane that is
 * depends on what the drafter made. Work it divided has a Graph: the nodes,
 * the order between them and the paths each reaches. Work it did not is one
 * piece, and there is no division to curate; its plan is the criteria it will
 * be judged against, which is the whole of what a person checks before
 * confirming. Neither is offered before there is a plan at all.
 *
 * Files and Impact are there from the first turn: both are about the draft's
 * scope, which is what the spec is being written against.
 */
const PANES = {
  spec: { id: "spec", label: "Spec", icon: "document" },
  graph: { id: "graph", label: "Graph", icon: "share" },
  criteria: { id: "criteria", label: "Plan", icon: "clipboard" },
  // Drawn as a folder, since what it lists is the repository's files.
  explorer: { id: "explorer", label: "Explorer", icon: "folder" },
  impact: { id: "impact", label: "Impact", icon: "growth-chart" },
  /**
   * The step between the plan and the contract, where the plan is read against
   * the spec it was drafted from (D-128).
   * A pane of planning, so the rail stays beside it; in the rail only while the
   * reading has found problems, because until then it is on the way to the
   * contract and nowhere to go to, and once it has, the problems are what the
   * planning is about until each is resolved or the person goes on past them.
   * Its id is "drift", which every route to it names.
   */
  drift: { id: "drift", label: "Problems", icon: "alert" },
} as const satisfies { [Id in PlanningPane]: { id: Id; label: string; icon: InkIconName } };
const REST = [PANES.explorer, PANES.impact] as const;
export const PLANNING_PANES = Object.values(PANES);

/** This planning's entry in the drafts list, where the list holds it. */
const draftOf = (drafts: Snapshot["drafts"], sessionId: string): OpenDraft | undefined =>
  (drafts ?? []).find((entry) => entry.id === sessionId);

/**
 * Whether this planning is the one curating its ticket's plan, which a session
 * alone does not make it: opening the ticket's own editor makes one too, and
 * sending that ticket into planning mode would put an interview dock over a
 * ticket with no spec and leave the editor unreachable. What marks a planning
 * is a plan to show there — a graph it was divided into, or the spec it was
 * drafted from, which is the pane its criteria are read on.
 */
export function curates(draft: OpenDraft): boolean {
  return draft.nodes > 0 || draft.specSlug !== null;
}

/**
 * Which pane holds this planning's plan, or null before there is one, which
 * is before it holds a ticket.
 *
 * The Graph for work the drafter divided, the criteria for work it did not.
 * One or the other, never both: they are two drawings of the same plan, and
 * offering the empty one as a stage is a stage a person goes looking into.
 */
export function planPaneFor(
  drafts: Snapshot["drafts"],
  sessionId: string,
): "graph" | "criteria" | null {
  const draft = draftOf(drafts, sessionId);
  if (draft === undefined || draft.key === null) return null;
  return draft.nodes > 0 ? "graph" : "criteria";
}

/**
 * The panes to offer this planning in the rail, which is all of them once it
 * has a plan, less the step to the contract — which is a place to go, after
 * Impact, only while the last reading of the plan against its spec has
 * problems open, and otherwise only the step every Confirm passes through
 * (D-128).
 */
export function panesFor(
  drafts: Snapshot["drafts"],
  sessionId: string,
): readonly (typeof PLANNING_PANES)[number][] {
  const plan = planPaneFor(drafts, sessionId);
  const problems = problemsOpen(drafts, sessionId) ? [PANES.drift] : [];
  return [PANES.spec, ...(plan === null ? [] : [PANES[plan]]), ...REST, ...problems];
}

/**
 * Whether reaching this pane is leaving the planning there, which every pane
 * is but one: the reading between the plan and the contract
 * (D-128). It is a step on the way to
 * the contract, which every Confirm the plan passes through, so recording it
 * would reopen the planning on the step rather than on the pane the person
 * confirmed from, and send the contract's Back to planning to the reading
 * rather than to the plan. Where the reading has left problems open, it is a
 * place to go, and {@link reopenPane} already lands the planning there.
 */
export function remembered(pane: PlanningPane): boolean {
  return pane !== "drift";
}

/**
 * The pane this planning was left at, where it still offers it
 * (D-130): null before the person has
 * been on one, and null where the pane they left is no longer offered — a
 * Graph the plan was put back together from — which leaves the caller's own
 * landing to apply.
 *
 * Asked by every way into a planning: the picker's rows, the ticket's own
 * page, a link that names no pane and the contract's way back.
 */
export function leftAt(drafts: Snapshot["drafts"], sessionId: string): PlanningPane | null {
  const pane = draftOf(drafts, sessionId)?.lastPane ?? null;
  return pane !== null && panesFor(drafts, sessionId).some((offered) => offered.id === pane)
    ? pane
    : null;
}

/** Whether a reading of this planning's plan against its spec has problems still open. */
export function problemsOpen(drafts: Snapshot["drafts"], sessionId: string): boolean {
  return (draftOf(drafts, sessionId)?.drift?.open ?? 0) > 0;
}

/**
 * Where a planning opens when nothing asks for a pane: its Problems pane while
 * a reading of its plan against its spec has problems open, since they are
 * then what the planning is about (D-128);
 * else where it was left; else its Spec, which is where a planning starts.
 */
export function reopenPane(drafts: Snapshot["drafts"], sessionId: string): PlanningPane {
  if (problemsOpen(drafts, sessionId)) return "drift";
  return leftAt(drafts, sessionId) ?? "spec";
}

/** Whether this ticket's plan is approved, as the snapshot's own row for it says. */
export function planApproved(workspace: Snapshot, repoId: string, key: string): boolean {
  return workspace.tasks.some(
    (row) => row.repoId === repoId && row.ticket.key === key && row.ticket.approved_at !== null,
  );
}

/**
 * Where confirming a plan goes, from every place that offers it: the Graph's
 * footer and its shortcut, the pane footer the other panes share, the Spec's
 * way to the plan and the criteria's Next.
 *
 * By way of the reading of the plan against its spec (D-128), which is the
 * one step between the plan and the contract and lands on the contract by
 * itself where there is nothing to say. An approved plan is frozen and goes
 * straight to its contract, and so does a plan with no planning to read it
 * in.
 */
export function confirmRoute(way: {
  repoId: string;
  key: string;
  sessionId: string | null | undefined;
  approved: boolean;
}): Route {
  return way.approved || way.sessionId == null
    ? { page: "task", repoId: way.repoId, key: way.key, view: "contract" }
    : { page: "planning", sessionId: way.sessionId, pane: "drift" };
}
