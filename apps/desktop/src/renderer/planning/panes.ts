import type { InkIconName } from "../ui/index.js";
import type { OpenDraft, PlanningPane, Snapshot } from "../../shared/protocol.js";
import { fingerprint } from "../../shared/contract-editing.js";
import type { Route } from "../shell/route.js";

/**
 * The panes planning mode has, in rail order, each by an id the protocol's
 * `PlanningPaneSchema` names. Each pane's ticket adds its entry here and
 * its id there; an id there with no entry here fails to compile, naming it.
 */
const PANES = {
  spec: { id: "spec", label: "Spec", icon: "document" },
  graph: { id: "graph", label: "Graph", icon: "share" },
  // Drawn as a folder, since what it lists is the repository's files.
  explorer: { id: "explorer", label: "Explorer", icon: "folder" },
  impact: { id: "impact", label: "Impact", icon: "growth-chart" },
  /**
   * The contract, after the plan's own panes: the page approving happens on,
   * reached inside planning rather than as a place of its own
   * (D-NEW-basic-and-epic-flows). Drawn as a
   * tick, the nearest drawing there is to "approve this".
   */
  contract: { id: "contract", label: "Confirm contract", icon: "approve" },
  /**
   * The problems a reading of the plan against the spec it was drafted from
   * found (D-128), each to be resolved before the plan goes on to the
   * contract: the lowest tab, and in the rail only while one is open. An
   * epic's Confirm the plan passes through it, which reads the plan where
   * anything the reading judges has moved since the last reading, and goes on
   * to the contract by itself where no problem is open.
   * Its id is "drift", which every route to it names.
   */
  drift: { id: "drift", label: "Problems", icon: "alert" },
} as const satisfies { [Id in PlanningPane]: { id: Id; label: string; icon: InkIconName } };
export const PLANNING_PANES = Object.values(PANES);
type Pane = (typeof PLANNING_PANES)[number];

/** This planning's entry in the drafts list, where the list holds it. */
const draftOf = (drafts: Snapshot["drafts"], sessionId: string): OpenDraft | undefined =>
  (drafts ?? []).find((entry) => entry.id === sessionId);

/**
 * What a planning is planning (D-NEW-basic-and-epic-flows):
 * "spec" while the spec is being written and there is no plan, "basic" for a
 * plan the drafter left flat, and "epic" for one it divided into a graph.
 */
export type PlanShape = "spec" | "basic" | "epic";
export function shapeOf(draft: Pick<OpenDraft, "key" | "nodes"> | undefined): PlanShape {
  if (draft === undefined || draft.key === null) return "spec";
  return draft.nodes > 0 ? "epic" : "basic";
}

/**
 * The state a person reaches a planning's contract at: the spec's sections,
 * as the host fingerprints them, the plan as its ticket last moved, and the
 * scope the planning holds. While it is the state recorded as they last
 * reached the contract, nothing has changed since and the contract is still
 * a tab to go back to (D-NEW-basic-and-epic-flows).
 */
export function contractState(
  workspace: Pick<Snapshot, "drafts" | "tasks">,
  draft: OpenDraft,
): string {
  const ticket = workspace.tasks.find(
    (row) => row.repoId === draft.repoId && row.ticket.key === draft.key,
  )?.ticket;
  return fingerprint(
    JSON.stringify([
      draft.spec,
      ticket?.updated_at ?? null,
      [...draft.scope.paths].sort(),
      [...draft.scope.prohibited].sort(),
    ]),
  );
}

/** What planning mode offers a planning. */
export interface PlanningFlow {
  shape: PlanShape;
  /** The panes the rail draws, in rail order. */
  panes: readonly Pane[];
}

/**
 * The one rule for which tabs a planning shows (D-NEW-basic-and-epic-flows).
 *
 * While the spec is being written there is no plan to measure anything
 * against, so the Spec and the Explorer are all there is. A plan divided into
 * a graph — an epic — offers its Graph second, then the Explorer and Impact.
 * A plan left flat — a basic ticket — has no graph to curate: the Explorer,
 * then Impact only where its check found paths outside the scope.
 *
 * The contract comes after them, and is a tab while the person is on it
 * (`current`), and after that while nothing has changed since they were —
 * the spec's words, a mark in the Explorer, an edit of the plan. Once
 * something has, it goes until the person reaches it again. A change a
 * person makes on a basic ticket's contract is made while they are on it, and
 * planning mode records the state it leaves as reached, so it keeps the tab.
 *
 * Problems is the lowest tab, below the contract, for either shape, and is
 * there only while a reading of the plan against its spec has a problem open
 * (D-128).
 */
export function flowFor(
  workspace: Pick<Snapshot, "drafts" | "tasks">,
  sessionId: string,
  current: PlanningPane | null = null,
): PlanningFlow {
  const draft = draftOf(workspace.drafts, sessionId);
  const shape = shapeOf(draft);
  const problems = problemsOpen(workspace.drafts, sessionId) ? [PANES.drift] : [];
  const panes: Pane[] =
    shape === "spec"
      ? [PANES.spec, PANES.explorer]
      : shape === "epic"
        ? [PANES.spec, PANES.graph, PANES.explorer, PANES.impact]
        : [PANES.spec, PANES.explorer, ...((draft?.impact ?? 0) > 0 ? [PANES.impact] : [])];
  const reachable =
    draft !== undefined &&
    draft.confirmed !== null &&
    draft.confirmed === contractState(workspace, draft);
  const contract = shape !== "spec" && (current === "contract" || reachable) ? [PANES.contract] : [];
  return { shape, panes: [...panes, ...contract, ...problems] };
}

/**
 * Whether this planning is the one curating its ticket's plan, which a session
 * alone does not make it: opening the ticket's own editor makes one too, and
 * sending that ticket into planning mode would put an interview dock over a
 * ticket with no spec and leave the editor unreachable. What marks a planning
 * is a plan to show there — a graph it was divided into, or the spec it was
 * drafted from.
 */
export function curates(draft: OpenDraft): boolean {
  return draft.nodes > 0 || draft.specSlug !== null;
}

/**
 * The pane that holds this planning's plan: the Graph for an epic, and none
 * for a basic ticket, whose plan is its contract, or for a planning with no
 * plan yet.
 */
export function planPaneFor(drafts: Snapshot["drafts"], sessionId: string): "graph" | null {
  return shapeOf(draftOf(drafts, sessionId)) === "epic" ? "graph" : null;
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
export function leftAt(workspace: Pick<Snapshot, "drafts" | "tasks">, sessionId: string): PlanningPane | null {
  const pane = draftOf(workspace.drafts, sessionId)?.lastPane ?? null;
  return pane !== null && flowFor(workspace, sessionId).panes.some((offered) => offered.id === pane)
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
export function reopenPane(workspace: Pick<Snapshot, "drafts" | "tasks">, sessionId: string): PlanningPane {
  if (problemsOpen(workspace.drafts, sessionId)) return "drift";
  return leftAt(workspace, sessionId) ?? "spec";
}

/**
 * Where a plan drafted again from a stopped run's spec lands
 * (D-NEW-basic-and-epic-flows, D-129): an
 * epic on its Graph, and a basic ticket on its contract, the page its
 * criteria are read and changed on, both inside the planning over it.
 */
export function draftedLanding(plan: { sessionId: string; nodes: number }): Route {
  return { page: "planning", sessionId: plan.sessionId, pane: plan.nodes > 0 ? "graph" : "contract" };
}

/**
 * Where a basic ticket lands once the impact check its fresh plan is given
 * has come back (D-NEW-basic-and-epic-flows): the Impact pane where it found
 * paths outside the scope, else the contract. Never on Problems: a basic
 * ticket's plan is read against its spec only at its Confirm contract.
 */
export function checkedLanding(checked: { flagged: boolean }): PlanningPane {
  return checked.flagged ? "impact" : "contract";
}

/** What the way on to the contract is called: an epic confirms its plan, a basic ticket its contract. */
export function confirmLabel(shape: PlanShape): string {
  return shape === "basic" ? "Confirm contract" : "Confirm the plan";
}

/** Whether this ticket's plan is approved, as the snapshot's own row for it says. */
export function planApproved(workspace: Snapshot, repoId: string, key: string): boolean {
  return workspace.tasks.some(
    (row) => row.repoId === repoId && row.ticket.key === key && row.ticket.approved_at !== null,
  );
}

/**
 * Where confirming a plan goes, from every place that offers it: the Graph's
 * footer and its shortcut, the pane footer the other panes share and the
 * Spec's way to the plan.
 *
 * An epic's goes by way of the Problems pane, which reads the plan against
 * its spec where anything the reading judges has moved since the last one
 * (D-128), holds the way on while a problem is open, and lands on the
 * contract tab by itself where none is. A basic ticket's goes to its
 * contract, where its criteria are edited and where its Confirm contract
 * reads the plan against the spec by the same rule
 * (D-NEW-basic-and-epic-flows). An approved plan is frozen and goes straight
 * to its contract, and so does a plan with no planning to read it in.
 *
 * Asked only by a press that navigates to what it returns, it records an
 * epic's confirm as on its way ({@link confirmArrives}): the Problems pane
 * reads the plan only on the arrival a confirm made, and an arrival by the
 * rail or a reopened planning shows the last reading's problems and starts
 * none.
 */
export function confirmRoute(way: {
  repoId: string;
  key: string;
  sessionId: string | null | undefined;
  approved: boolean;
  basic: boolean;
}): Route {
  if (way.approved || way.sessionId == null) return { page: "task", repoId: way.repoId, key: way.key, view: "contract" };
  if (!way.basic) confirmsOnTheWay.add(way.sessionId);
  return { page: "planning", sessionId: way.sessionId, pane: way.basic ? "contract" : "drift" };
}

/** The plannings whose Confirm the plan is on its way to their Problems pane. */
const confirmsOnTheWay = new Set<string>();

/**
 * Whether this planning's arrival at its Problems pane is a Confirm the
 * plan's, which is the one arrival that reads the plan against its spec
 * (D-NEW-basic-and-epic-flows). `take` is the arrival itself, which uses it
 * up, so a later arrival by the rail is not taken for a confirm.
 */
export function confirmArrives(sessionId: string, take = false): boolean {
  return take ? confirmsOnTheWay.delete(sessionId) : confirmsOnTheWay.has(sessionId);
}
