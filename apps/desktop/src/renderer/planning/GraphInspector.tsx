import { useEffect, useState } from "react";
import { Button, Dialog, cx } from "../ui/index.js";
import { VERIFICATION_KINDS } from "@perbo/contracts/plan";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import { LineIcon } from "../icons.js";
import type {
  GraphCriterionState,
  GraphCriterionView,
  GraphNodeLive,
  GraphNodeView,
  GraphView,
} from "../../shared/protocol.js";

/**
 * One node, open: its criteria and its paths, which are contract; the order
 * around it, which is approach; and the page generated for it beside the spec,
 * read-only because every line of it is derived (D-100, D-103).
 *
 * Each control produces one {@link GraphEdit} and hands it up. Nothing here
 * holds a draft of the plan: the text being typed is local until it is left,
 * and what is shown otherwise is what the store says.
 */

/** The verification kinds a person may choose here; `manual` is stated at the command line. */
const KINDS = VERIFICATION_KINDS.filter((kind) => kind !== "manual");

export function GraphInspector({
  view,
  node,
  live,
  busy,
  apply,
  onSplit,
  onClose,
}: {
  view: GraphView;
  node: GraphNodeView;
  /** What the run's records say about this node, or undefined for a node they do not name. */
  live: GraphNodeLive | undefined;
  busy: boolean;
  apply: (edit: GraphEdit) => void;
  onSplit: () => void;
  onClose: () => void;
}) {
  const others = view.nodes.filter((each) => each.id !== node.id);
  const after = view.edges.filter((edge) => edge.to === node.id);
  const before = view.edges.filter((edge) => edge.from === node.id);
  const [path, setPath] = useState("");
  const setPaths = (paths: string[]): void => {
    if (paths.length === 0) return;
    apply({ op: "set_node_paths", id: node.id, paths });
  };
  return (
    <section className="inspector" aria-label={`Node ${node.id}`}>
      <div className="insp-head">
        <span className="node-label">{node.id}</span>
        <strong>{node.title}</strong>
        <span className="spacer" />
        <Button
          className="small"
          disabled={busy || node.criteria.length < 2}
          title={node.criteria.length < 2 ? "A split needs a criterion for each half" : ""}
          onClick={onSplit}
        >
          Split…
        </Button>
        <Button className="small" aria-label="Close the node" onClick={onClose}>
          ×
        </Button>
      </div>
      <div className="insp-body">
        <div className="insp-main">
          <span className="section-label">Acceptance criteria · {node.criteria.length}</span>
          {node.criteria.map((criterion) => (
            <CriterionEdit
              key={criterion.id}
              criterion={criterion}
              state={live?.criteria.find((each) => each.id === criterion.id)}
              busy={busy}
              apply={apply}
            />
          ))}
        </div>
        <div className="insp-side">
          <div>
            <span className="section-label">Paths expected to satisfy them</span>
            <div className="path-chips">
              {node.paths.map((each) => (
                <span key={each} className="path-chip">
                  {each}
                  <button
                    type="button"
                    disabled={busy || node.paths.length < 2}
                    aria-label={`Remove ${each}`}
                    title={
                      node.paths.length < 2 ? "A node names at least one path" : `Remove ${each}`
                    }
                    onClick={() => setPaths(node.paths.filter((held) => held !== each))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className="mini-input"
              aria-label="Add a path or glob"
              placeholder="+ add a path or glob, then ↵"
              list={`graph-paths-${node.id}`}
              value={path}
              disabled={busy}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const wanted = path.trim();
                if (wanted === "" || node.paths.includes(wanted)) return;
                setPaths([...node.paths, wanted]);
                setPath("");
              }}
            />
            <datalist id={`graph-paths-${node.id}`}>
              {view.pathsAllowed.map((glob) => (
                <option key={glob} value={glob} />
              ))}
            </datalist>
          </div>
          <div>
            <span className="section-label">Comes after</span>
            <div className="path-chips">
              {after.map((edge) => (
                <span key={edge.from} className="path-chip">
                  {edge.from}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove the edge ${edge.from} to ${edge.to}`}
                    onClick={() => apply({ op: "remove_edge", from: edge.from, to: edge.to })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <select
                className="select-mini"
                aria-label="Add a node this one comes after"
                value=""
                disabled={busy}
                onChange={(event) =>
                  apply({ op: "add_edge", from: event.target.value, to: node.id })
                }
              >
                <option value="">+ after…</option>
                {others.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.id} {each.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <span className="section-label">Comes before</span>
            <div className="path-chips">
              {before.map((edge) => (
                <span key={edge.to} className="path-chip">
                  {edge.to}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove the edge ${edge.from} to ${edge.to}`}
                    onClick={() => apply({ op: "remove_edge", from: edge.from, to: edge.to })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <select
                className="select-mini"
                aria-label="Add a node this one comes before"
                value=""
                disabled={busy}
                onChange={(event) => apply({ op: "add_edge", from: node.id, to: event.target.value })}
              >
                <option value="">+ before…</option>
                {others.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.id} {each.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="small muted">
            Criteria and paths become contract when you approve. The order is a suggestion to the
            executor.
          </p>
        </div>
        <div className="insp-page">
          <span className="section-label">
            {node.page === null ? "Generated page" : node.page.path}
            <span className="ro-chip">read-only</span>
          </span>
          {node.page === null ? (
            <p className="small muted">
              This plan was not drafted from a spec, so there is no page to generate. A spec gives
              every node one (<LineIcon name="spec" size={12} /> D-103).
            </p>
          ) : (
            <pre className="code node-page" aria-label={node.page.path}>
              {node.page.text}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Where a criterion stands, as the review artifact's evidence binding leaves
 * it (SCP-317): whether it was met, how it was established — a mock the
 * executor also wrote is not a proof — where the evidence is, and any finding
 * still open against it. Nothing here reads the executor's own account.
 */
function CriterionState({ state }: { state: GraphCriterionState }) {
  const word = {
    met: "met",
    not_met: "not met",
    cannot_determine: "cannot determine",
    unbound: "not yet reviewed",
  }[state.state];
  const strength = {
    directly_verified: "directly verified",
    proxy: "by proxy",
    asserted_only: "asserted only",
  };
  return (
    <p className={cx("crit-state", `crit-state--${state.state}`)}>
      <span className="state-word">{word}</span>
      {state.strength !== null && <span className="small muted">{strength[state.strength]}</span>}
      {state.evidence !== null && <span className="small mono">{state.evidence}</span>}
      {state.finding !== null && <span className="crit-finding">{state.finding}</span>}
    </p>
  );
}

/** One criterion's text and how it is proven; both go in one `set_criterion`. */
function CriterionEdit({
  criterion,
  state,
  busy,
  apply,
}: {
  criterion: GraphCriterionView;
  state: GraphCriterionState | undefined;
  busy: boolean;
  apply: (edit: GraphEdit) => void;
}) {
  const [text, setText] = useState(criterion.text);
  useEffect(() => setText(criterion.text), [criterion.text]);
  const set = (next: { text?: string; kind?: GraphCriterionView["kind"] }): void => {
    const kind = next.kind ?? criterion.kind;
    apply({
      op: "set_criterion",
      id: criterion.id,
      text: next.text ?? criterion.text,
      expected_verification: {
        kind,
        assertion: criterion.assertion,
        // A criterion proven by hand carries who proves it and why (the schema
        // refuses one without them); a kind chosen here is never manual.
        ...(kind === "manual" && criterion.manual !== null
          ? { manual_reviewer: criterion.manual.reviewer, manual_reason: criterion.manual.reason }
          : {}),
      },
    });
  };
  return (
    <div className="crit-edit">
      <span className="crit-n">{criterion.id}</span>
      <div>
        <textarea
          rows={2}
          aria-label={`Criterion ${criterion.id}`}
          placeholder="What must be true?"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const wanted = text.trim();
            if (wanted === "") {
              setText(criterion.text);
              return;
            }
            if (wanted !== criterion.text) set({ text: wanted });
          }}
        />
        <div className="kind-seg" role="group" aria-label={`How ${criterion.id} is proven`}>
          {KINDS.map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={criterion.kind === kind}
              disabled={busy}
              onClick={() => {
                if (criterion.kind !== kind) set({ kind });
              }}
            >
              {kind}
            </button>
          ))}
        </div>
        <p className="small muted">
          Proven by {criterion.kind}: {criterion.assertion}
          {criterion.requirement === null ? "" : ` · drafted from ${criterion.requirement}`}
        </p>
        {state && <CriterionState state={state} />}
      </div>
    </div>
  );
}

/** The half a criterion or a path goes to: the first, the second, or both. */
type Half = 0 | 1 | 2;

/**
 * Two nodes replace one. Every criterion goes to exactly one half — the edit
 * path refuses a split that leaves one in neither — and a path may go to both,
 * because two halves of one node often touch the same files.
 */
export function SplitDialog({
  node,
  onClose,
  onSplit,
}: {
  node: GraphNodeView;
  onClose: () => void;
  onSplit: (edit: GraphEdit) => void;
}) {
  const half = Math.ceil(node.criteria.length / 2);
  const [titles, setTitles] = useState([`${node.title} (part 1)`, `${node.title} (part 2)`]);
  const [criteria, setCriteria] = useState<Record<string, Half>>(() =>
    Object.fromEntries(node.criteria.map((criterion, at) => [criterion.id, at < half ? 0 : 1])),
  );
  const [paths, setPaths] = useState<Record<string, Half>>(() =>
    Object.fromEntries(
      node.paths.map((path, at) => [
        path,
        node.paths.length === 1 ? 2 : at < Math.ceil(node.paths.length / 2) ? 0 : 1,
      ]),
    ),
  );
  const held = (side: Half) => ({
    criteria: node.criteria.filter((criterion) => criteria[criterion.id] === side).map((c) => c.id),
    paths: node.paths.filter((path) => paths[path] === side || paths[path] === 2),
  });
  const first = held(0);
  const second = held(1);
  const ready =
    first.criteria.length > 0 &&
    second.criteria.length > 0 &&
    first.paths.length > 0 &&
    second.paths.length > 0;
  const chooser = (
    label: string,
    value: Half,
    set: (next: Half) => void,
    options: readonly [Half, string][],
  ) => (
    <span className="seg" role="group" aria-label={label}>
      {options.map(([side, text]) => (
        <button
          type="button"
          key={text}
          aria-pressed={value === side}
          onClick={() => set(side)}
        >
          {text}
        </button>
      ))}
    </span>
  );
  return (
    <Dialog title={`Split node ${node.id}`} onClose={onClose}>
      <p>
        Two nodes replace {node.id}. Each keeps the criteria and paths you give it, and each needs
        at least one of both; both inherit {node.id}&rsquo;s edges. Nothing else in the graph
        changes.
      </p>
      <div className="split-names">
        {[0, 1].map((side) => (
          <input
            key={side}
            aria-label={`Title of the ${side === 0 ? "first" : "second"} half`}
            value={titles[side]}
            onChange={(event) =>
              setTitles(side === 0 ? [event.target.value, titles[1]!] : [titles[0]!, event.target.value])
            }
          />
        ))}
      </div>
      <div className="split-grid">
        {node.criteria.map((criterion) => (
          <div key={criterion.id} className="split-row">
            <span>{criterion.text}</span>
            {chooser(
              `Which half ${criterion.id} goes to`,
              criteria[criterion.id] ?? 0,
              (next) => setCriteria({ ...criteria, [criterion.id]: next }),
              [
                [0, "first"],
                [1, "second"],
              ],
            )}
          </div>
        ))}
        {node.paths.map((path) => (
          <div key={path} className={cx("split-row", "mono")}>
            <span>{path}</span>
            {chooser(
              `Which half ${path} goes to`,
              paths[path] ?? 2,
              (next) => setPaths({ ...paths, [path]: next }),
              [
                [0, "first"],
                [1, "second"],
                [2, "both"],
              ],
            )}
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() =>
            onSplit({
              op: "split_node",
              id: node.id,
              into: [
                { title: titles[0]!.trim() || node.title, ...first },
                { title: titles[1]!.trim() || node.title, ...second },
              ],
            })
          }
        >
          Split
        </Button>
      </div>
    </Dialog>
  );
}
