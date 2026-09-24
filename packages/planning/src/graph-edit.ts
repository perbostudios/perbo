import {
  AcceptanceCriterionSchema,
  APPROACH_SCHEMA_VERSION,
  approachProblems,
  ApproachRecordSchema,
  GraphEditSchema,
  hasAcceptanceCriteria,
  PlanContractSchema,
  planNodes,
  type AcceptanceCriterion,
  type ApproachRecord,
  type GraphEdge,
  type GraphEdit,
  type PlanContract,
  type PlanNode,
} from "@perbo/contracts/browser";
import { PlanningError } from "./errors.js";

/**
 * The one validated edit path for a plan's execution graph (D-100).
 *
 * Every operation is applied to a **copy**, the result is validated as a whole
 * — `PlanContractSchema`, the approach schema and the edge-ends check — and a
 * result that does not validate is a refusal that changed nothing. There is no
 * partial application and no repair.
 *
 * Each edit records the entity keys it touched (`node:<id>`, `criterion:<id>`,
 * `edge:<from>-><to>`) with each key's value before and after. That record is
 * what an undo replays, and what decides whether a later edit blocks one.
 *
 * It sits in this package rather than in `perbo edit`, which is the command
 * that runs it against a store, because a second surface applies the same
 * operations to the same schema: the desktop's browser preview, which has no
 * command line to hand them to. Nothing here touches a filesystem or a process.
 */

/**
 * The keys an edit records against, in the words `--undo` reports them in.
 * An edge's key joins its ends with `->`, which no node id can contain, so the
 * key reads back as one edge and not another.
 */
export const nodeKey = (id: string) => `node:${id}`;
export const criterionKey = (id: string) => `criterion:${id}`;
export const edgeKey = (edge: GraphEdge) => `edge:${edge.from}->${edge.to}`;

/** A plan and its approach, as one thing to edit. */
export interface GraphState {
  contract: PlanContract;
  approach: ApproachRecord;
}

export interface GraphEditOutcome extends GraphState {
  /** One line for a person: what this edit did. */
  summary: string;
  keys: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /**
   * Whether the edit left the contract untouched. An edge is approach and may
   * change after approval; a node's criteria and paths are contract and may
   * not (ADR-0016).
   */
  approachOnly: boolean;
}

/** The working form: the contract's lists, flattened so an edit can move things. */
interface Working {
  criteria: AcceptanceCriterion[];
  nodes: PlanNode[];
  edges: GraphEdge[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function read(state: GraphState): Working {
  if (!hasAcceptanceCriteria(state.contract)) {
    throw new PlanningError(
      "this plan is P0, which carries no acceptance criteria, so it has nothing to group into nodes",
    );
  }
  return {
    criteria: clone([...state.contract.acceptance_criteria]),
    nodes: clone([...planNodes(state.contract)]),
    edges: clone([...state.approach.edges]),
  };
}

/** The next free `<prefix>_<n>`, one past the highest in use. */
function nextId(prefix: string, used: readonly string[]): string {
  const highest = used.reduce((largest, id) => {
    const suffix = Number(id.slice(prefix.length + 1));
    return Number.isInteger(suffix) && suffix > largest ? suffix : largest;
  }, 0);
  return `${prefix}_${highest + 1}`;
}

const nodeOf = (working: Working, id: string): PlanNode => {
  const node = working.nodes.find((each) => each.id === id);
  if (!node) {
    throw new PlanningError(
      `this plan has no node ${id}. It has ${
        working.nodes.length === 0
          ? "no nodes at all; add one with add_node"
          : working.nodes.map((each) => each.id).join(", ")
      }`,
    );
  }
  return node;
};

const criterionOf = (working: Working, id: string): AcceptanceCriterion => {
  const criterion = working.criteria.find((each) => each.id === id);
  if (!criterion) {
    throw new PlanningError(
      `this plan has no criterion ${id}. It has ${working.criteria
        .map((each) => each.id)
        .join(", ")}`,
    );
  }
  return criterion;
};

/** Take criteria out of whatever nodes hold them; drop a node left with none. */
function detach(working: Working, ids: readonly string[]): void {
  const taken = new Set(ids);
  for (const node of working.nodes) {
    node.criteria = node.criteria.filter((id) => !taken.has(id));
  }
  const emptied = working.nodes.filter((node) => node.criteria.length === 0);
  working.nodes = working.nodes.filter((node) => node.criteria.length > 0);
  const gone = new Set(emptied.map((node) => node.id));
  working.edges = working.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
}

function applyToWorking(
  working: Working,
  edit: GraphEdit,
  context: { outcome: string; pathsAllowed: readonly string[]; reserved: readonly string[] },
): { summary: string; approachOnly: boolean } {
  const freeNode = () =>
    nextId("node", [...working.nodes.map((each) => each.id), ...context.reserved]);
  const freeCriterion = () =>
    nextId("ac", [...working.criteria.map((each) => each.id), ...context.reserved]);
  switch (edit.op) {
    case "add_node": {
      const flat = working.nodes.length === 0;
      for (const id of edit.criteria) criterionOf(working, id);
      const written = edit.new_criteria.map((criterion) => {
        const added = AcceptanceCriterionSchema.parse({
          id: freeCriterion(),
          text: criterion.text,
          expected_verification: criterion.expected_verification,
          // Carried through, so a criterion an edit writes says which
          // requirement it answers and the node's page can name it (D-103).
          ...(criterion.requirement_id === undefined
            ? {}
            : { requirement_id: criterion.requirement_id }),
        });
        working.criteria.push(added);
        return added.id;
      });
      const criteria = [...edit.criteria, ...written];
      const id = freeNode();
      detach(working, criteria);
      working.nodes.push({ id, title: edit.title, criteria, paths: [...edit.paths] });
      if (flat) {
        // The plan had no graph, so the criteria this node did not take have
        // nowhere to be. They go into a node of their own named for the plan's
        // outcome, over the whole scope the plan already allows — the rest of
        // the work may land anywhere in it — because every criterion is in
        // exactly one node or there is no graph at all, and a half-grouped plan
        // is the state the schema exists to make unrepresentable.
        const rest = working.criteria
          .map((criterion) => criterion.id)
          .filter((each) => !criteria.includes(each));
        if (rest.length > 0) {
          working.nodes.push({
            id: freeNode(),
            title: context.outcome,
            criteria: rest,
            paths: [...context.pathsAllowed],
          });
        }
      }
      return { summary: `${id} added: ${edit.title} (${criteria.join(", ")})`, approachOnly: false };
    }
    case "split_node": {
      const node = nodeOf(working, edit.id);
      const kept = new Set([...edit.into[0].criteria, ...edit.into[1].criteria]);
      const lost = node.criteria.filter((id) => !kept.has(id));
      if (lost.length > 0) {
        throw new PlanningError(
          `splitting ${edit.id} would leave ${lost.join(", ")} in neither half. Name every one of ` +
            `its criteria across the two halves, or delete it first`,
        );
      }
      const at = working.nodes.indexOf(node);
      const second = {
        id: freeNode(),
        title: edit.into[1].title,
        criteria: [...edit.into[1].criteria],
        paths: [...edit.into[1].paths],
      };
      // The first half keeps the id and the place: the node did not stop
      // existing, it got smaller, and every edge already pointing at it still
      // means what it meant.
      working.nodes[at] = {
        id: node.id,
        title: edit.into[0].title,
        criteria: [...edit.into[0].criteria],
        paths: [...edit.into[0].paths],
      };
      working.nodes.splice(at + 1, 0, second);
      return { summary: `${node.id} split into ${node.id} and ${second.id}`, approachOnly: false };
    }
    case "merge_nodes": {
      const [keepId, goneId] = edit.ids;
      const keep = nodeOf(working, keepId);
      const gone = nodeOf(working, goneId);
      keep.title = edit.title ?? keep.title;
      keep.criteria = [...keep.criteria, ...gone.criteria];
      keep.paths = [...new Set([...keep.paths, ...gone.paths])];
      working.nodes = working.nodes.filter((node) => node.id !== goneId);
      // Every edge that named the node that is gone now names the survivor;
      // the edge between the two has nothing left to order, and an edge to a
      // third node that both had is one edge, not two.
      const rewritten = working.edges
        .map((edge) => ({
          from: edge.from === goneId ? keepId : edge.from,
          to: edge.to === goneId ? keepId : edge.to,
        }))
        .filter((edge) => edge.from !== edge.to);
      const seen = new Set<string>();
      working.edges = rewritten.filter((edge) => {
        const key = edgeKey(edge);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { summary: `${goneId} merged into ${keepId}`, approachOnly: false };
    }
    case "delete_node": {
      const node = nodeOf(working, edit.id);
      const deleted = new Set(edit.delete_criteria);
      const moved = node.criteria.filter((id) => !deleted.has(id));
      // The last node has nowhere to move its criteria to; deleting it whole
      // ungroups the plan, which keeps every criterion and drops the graph.
      if (working.nodes.length === 1 && deleted.size === 0 && edit.move_criteria_to === null) {
        working.nodes = [];
        working.edges = [];
        return { summary: `${node.id} deleted; the plan is flat again`, approachOnly: false };
      }
      if (moved.length > 0 && edit.move_criteria_to === null) {
        throw new PlanningError(
          `deleting ${edit.id} would strand ${moved.join(", ")}. A criterion belongs to a node: ` +
            "give move_criteria_to, or name each one in delete_criteria",
        );
      }
      if (edit.move_criteria_to !== null) {
        const into = nodeOf(working, edit.move_criteria_to);
        if (into.id === node.id) {
          throw new PlanningError(`${edit.id} cannot take its own criteria: it is being deleted`);
        }
        into.criteria = [...into.criteria, ...moved];
      }
      working.criteria = working.criteria.filter((criterion) => !deleted.has(criterion.id));
      working.nodes = working.nodes.filter((each) => each.id !== node.id);
      working.edges = working.edges.filter(
        (edge) => edge.from !== node.id && edge.to !== node.id,
      );
      return {
        summary:
          `${node.id} deleted` +
          (deleted.size > 0 ? `, with ${[...deleted].join(", ")}` : "") +
          (edit.move_criteria_to !== null && moved.length > 0
            ? `, ${moved.join(", ")} moved to ${edit.move_criteria_to}`
            : ""),
        approachOnly: false,
      };
    }
    case "set_criterion": {
      const criterion = criterionOf(working, edit.id);
      criterion.text = edit.text;
      criterion.expected_verification = edit.expected_verification;
      return { summary: `${edit.id} reworded`, approachOnly: false };
    }
    case "set_node_paths": {
      const node = nodeOf(working, edit.id);
      node.paths = [...edit.paths];
      return { summary: `${edit.id} paths set to ${edit.paths.join(", ")}`, approachOnly: false };
    }
    case "add_edge": {
      nodeOf(working, edit.from);
      nodeOf(working, edit.to);
      working.edges.push({ from: edit.from, to: edit.to });
      return { summary: `edge ${edit.from} -> ${edit.to} added`, approachOnly: true };
    }
    case "remove_edge": {
      const key = edgeKey(edit);
      if (!working.edges.some((edge) => edgeKey(edge) === key)) {
        throw new PlanningError(`this plan has no edge ${edit.from} -> ${edit.to}`);
      }
      working.edges = working.edges.filter((edge) => edgeKey(edge) !== key);
      return { summary: `edge ${edit.from} -> ${edit.to} removed`, approachOnly: true };
    }
  }
}

/** Everything the working form holds, keyed the way an edit records it. */
function entities(working: Working): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const criterion of working.criteria) map.set(criterionKey(criterion.id), criterion);
  for (const node of working.nodes) map.set(nodeKey(node.id), node);
  for (const edge of working.edges) map.set(edgeKey(edge), edge);
  return map;
}

/** What changed between two working forms, as keys with their values either side. */
function difference(
  was: Working,
  now: Working,
): { keys: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const left = entities(was);
  const right = entities(now);
  const keys: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of [...new Set([...left.keys(), ...right.keys()])]) {
    const a = left.get(key) ?? null;
    const b = right.get(key) ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    keys.push(key);
    before[key] = a;
    after[key] = b;
  }
  return { keys, before, after };
}

/** Rebuild and validate: the copy becomes the new state or the edit is refused. */
function seal(state: GraphState, working: Working, what: string): GraphState {
  const candidate: Record<string, unknown> = {
    ...state.contract,
    acceptance_criteria: working.criteria,
  };
  // A plan with no nodes carries no `nodes` key at all: an empty list would be
  // a third state, meaning neither "flat" nor "grouped".
  if (working.nodes.length > 0) candidate["nodes"] = working.nodes;
  else delete candidate["nodes"];
  const parsed = PlanContractSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanningError(
      `${what} would leave a plan this schema refuses, so nothing was changed:\n` +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join(".") || "(contract)"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const approach = ApproachRecordSchema.safeParse({
    ...state.approach,
    edges: working.edges,
  });
  if (!approach.success) {
    throw new PlanningError(
      `${what} would leave an order this schema refuses, so nothing was changed:\n` +
        approach.error.issues
          .map((issue) => `  ${issue.path.join(".") || "(approach)"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const dangling = approachProblems(approach.data, planNodes(parsed.data));
  if (dangling.length > 0) {
    throw new PlanningError(`${what} would leave ${dangling.join("; ")}, so nothing was changed`);
  }
  return { contract: parsed.data, approach: approach.data };
}

/** An empty approach for a plan that has never had one. */
export function emptyApproach(contract: PlanContract): ApproachRecord {
  return ApproachRecordSchema.parse({
    schema_version: APPROACH_SCHEMA_VERSION,
    ticket_id: contract.ticket_id,
    plan_id: contract.plan_id,
    edges: [],
    no_gos: [],
  });
}

/**
 * One edit, applied to a copy and validated whole.
 *
 * `reserved` is every node and criterion id earlier edits mentioned, including
 * ones since deleted. A new id is never one of them: the undo log addresses
 * entities by id, so reusing one would make an earlier edit's record point at
 * something it never touched.
 */
export function applyGraphEdit(
  state: GraphState,
  raw: unknown,
  reserved: readonly string[] = [],
): GraphEditOutcome {
  const parsed = GraphEditSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanningError(
      "this is not a graph edit:\n" +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join(".") || "(edit)"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const was = read(state);
  const working = read(state);
  const { summary, approachOnly } = applyToWorking(working, parsed.data, {
    outcome: state.contract.outcome,
    pathsAllowed: state.contract.scope.paths_allowed,
    reserved,
  });
  const sealed = seal(state, working, parsed.data.op);
  return { ...sealed, summary, approachOnly, ...difference(was, working) };
}

/** As much of a recorded edit as D-100's undo rule needs to read. */
export interface RecordedEdit {
  /** `node:<id>`, `criterion:<id>`, `edge:<from>-><to>`. */
  keys: readonly string[];
  undone: boolean;
  /** True once a re-draft from the spec replaced the contract it changed. */
  replaced: boolean;
  /** The edit this one undid, by its number, or null for an edit of its own. */
  undoes: number | null;
}

/**
 * The later edit standing in the way of undoing edit `number`, with the keys
 * they share, or null where nothing is (D-100).
 *
 * An undo entry is not itself "a later edit" for this purpose — it is the
 * removal of one — so undoing edit 4 and then edit 3 works, which is the order
 * a person retracing their steps takes them in. The wording of the refusal is
 * the caller's: the command names the ticket and the flag, and a pane names
 * neither.
 */
export function blockingEdit(
  edits: readonly RecordedEdit[],
  number: number,
): { at: number; keys: string[] } | null {
  const target = edits[number - 1];
  if (!target) return null;
  const touched = new Set(target.keys);
  for (let index = number; index < edits.length; index += 1) {
    const later = edits[index]!;
    if (later.undone || later.replaced || later.undoes !== null) continue;
    const keys = later.keys.filter((each) => touched.has(each));
    if (keys.length > 0) return { at: index + 1, keys };
  }
  return null;
}

/**
 * Put back what one edit changed, key by key: a value that was there is
 * restored where it stands, one that was not is removed, and one that has since
 * gone back on the end. Nothing about the order of nodes is recorded, so a node
 * that had been deleted comes back last; nothing reads that order but the
 * rendering.
 */
export function undoGraphEdit(
  state: GraphState,
  before: Record<string, unknown>,
): GraphEditOutcome {
  const was = read(state);
  const working = read(state);
  for (const [key, value] of Object.entries(before)) {
    const kind = key.slice(0, key.indexOf(":"));
    const id = key.slice(key.indexOf(":") + 1);
    if (kind === "edge") {
      working.edges = working.edges.filter((edge) => edgeKey(edge) !== key);
      if (value !== null) working.edges.push(value as GraphEdge);
      continue;
    }
    const list: Array<{ id: string }> =
      kind === "node" ? working.nodes : (working.criteria as Array<{ id: string }>);
    const at = list.findIndex((each) => each.id === id);
    if (value === null) {
      if (at !== -1) list.splice(at, 1);
      continue;
    }
    if (at === -1) list.push(value as { id: string });
    else list[at] = value as { id: string };
  }
  const sealed = seal(state, working, "undoing that edit");
  const changed = difference(was, working);
  return {
    ...sealed,
    summary: "undone",
    approachOnly: changed.keys.every((key) => key.startsWith("edge:")),
    ...changed,
  };
}
