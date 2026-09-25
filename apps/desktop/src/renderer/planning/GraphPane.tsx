import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Notice, cx } from "../ui/index.js";
import { SIZE_COUNTS, SIZE_NAMES, SIZE_THRESHOLDS, type GraphEdit } from "@perbo/contracts/browser";
import { bridge, errorMessage, useAction, useGraph } from "../workspace/index.js";
import { useSettled } from "./settled.js";
import { useShortcut } from "../shell/shortcuts.js";
import { GraphInspector, SplitDialog } from "./GraphInspector.js";
import { MarkedCriterion } from "./ChangeMarks.js";
import { changeKey, criteriaChange, type CriteriaChange } from "./change-marks.js";
import { graphColumns, nodeSummary } from "./graph-layout.js";
import { graphHistory, latestUndoable } from "./history.js";
import type {
  GraphNodeLive,
  GraphNodeState,
  GraphNodeView,
  GraphView,
  Snapshot,
} from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";
import type { Route } from "../shell/route.js";
import { confirmRoute } from "./panes.js";

/**
 * The Graph pane (D-100, D-101, SCP-316): the plan's execution graph, the size
 * derived from it, and the confirmation at the end of it, which leads to the
 * contract where the one approval is given.
 *
 * **The pane writes nothing.** Every change is one `GraphEdit` handed to the
 * host, which runs `perbo edit --graph-edit` — the same command the interview
 * uses — so each edit is validated whole, recorded with its author and
 * undoable, and the contract and the approach record are only ever written by
 * that command. What the pane holds is a selection, a pan offset and a zoom.
 *
 * The drawing is its own: positioned nodes and an SVG layer of edges, because
 * the renderer runs under a policy that allows no worker and no remote origin
 * ({@link ../../../index.html}).
 */

type Editor = ReturnType<typeof useContractEditing>;

export function GraphPane({
  workspace,
  navigate,
  editor,
}: {
  workspace: Snapshot;
  navigate: (route: Route) => void;
  editor: Editor;
}) {
  const client = useQueryClient();
  const settled = useSettled();
  const action = useAction();
  const session = editor.session;
  const repoId = editor.repoId;
  const key = session?.key ?? null;
  const [selected, setSelected] = useState<string[]>([]);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [startingOver, setStartingOver] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The records this pane reads are written while a run moves, so the pane
   * follows them (D-100). It reads through the workspace refresh, which takes
   * a repository again on a records change and on the poll — about two seconds
   * while a run is live, fifteen while none is — and patches a progress update
   * where it stands without reading anything (D-095).
   */
  const graph = useGraph(repoId, key);
  const view: GraphView | undefined = graph.data;

  /** One edit, through the host, with the pane redrawn from what the store then holds. */
  const apply = useCallback(
    async (request: { kind: "graphEdit"; edit: GraphEdit } | { kind: "graphUndo"; edit: number }) => {
      if (key === null) return;
      setBusy(true);
      setFailure(null);
      try {
        const job = await settled(
          await bridge.request(
            request.kind === "graphEdit"
              ? { kind: "graphEdit", repoId, key, edit: request.edit }
              : { kind: "graphUndo", repoId, key, edit: request.edit },
          ),
        );
        if (job.error) setFailure(job.error);
        await client.invalidateQueries({ queryKey: ["graph", repoId, key] });
      } catch (error) {
        setFailure(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [client, key, repoId, settled],
  );

  const held = useMemo(
    () => selected.filter((id) => (view?.nodes ?? []).some((node) => node.id === id)),
    [selected, view],
  );
  // The last change to the plan's promise, by criterion, for the marks on
  // the node cards and in the inspector (D-128).
  // Diffed once per change rather than once per session read, which hands
  // over a fresh object for the same change.
  const planChange = session?.change?.plan ?? null;
  const changed = changeKey(session?.change ?? null);
  const changes = useMemo(
    () => (planChange === null ? null : criteriaChange(planChange.before.criteria, planChange.after.criteria)),
    [changed],
  );
  const one = held.length === 1 ? view?.nodes.find((node) => node.id === held[0]) : undefined;
  // Confirming the plan is saying the division is right, and it leads to the
  // page where what freezes is shown — the outcome, the criteria, the scope
  // and the base. Approval happens there and nowhere else: one contract has
  // one approval, on the screen that states what is being approved.
  //
  // Where {@link confirmRoute} says every way there goes; the shortcut takes
  // the same way, so it cannot skip the reading.
  //
  // Not while the chat is mid-turn on a plan not yet approved: what approving
  // freezes is what the contract holds when it is read (ADR-0016), and a turn
  // in flight may still be moving this plan. Checked here rather than only on
  // the button, because the shortcut reaches this without passing one.
  const thinking = !view?.approved && (workspace.working ?? []).includes(session?.id ?? "");
  const confirm = (): void => {
    if (view === undefined || busy || action.isPending || thinking) return;
    navigate(confirmRoute({ repoId, key: view.key, sessionId: session?.id, approved: view.approved }));
  };
  useShortcut("approve", view === undefined || busy || action.isPending || thinking ? null : confirm);

  if (!session)
    return (
      <section className="screen" data-screen="graph">
        <div className="pane-head">
          <h2>Execution graph</h2>
        </div>
        <p className="small muted">Opening this planning…</p>
      </section>
    );
  if (key === null)
    return (
      <section className="screen" data-screen="graph">
        <div className="pane-head">
          <h2>Execution graph</h2>
          <span className="sub">one piece of work, divided into nodes</span>
        </div>
        <div className="graph-empty">
          <div className="ghost" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <h2>No graph yet</h2>
          <p>
            Write the spec, then press Generate plan in the Spec pane. The drafter turns it into a
            contract and suggests a graph here: nodes, their criteria and paths, and the order
            between them.
          </p>
        </div>
      </section>
    );

  // A flat plan has criteria and no graph: nothing to curate on a canvas, and
  // still one approval, which is the pane's to give for any plan in review.
  const flat = view !== undefined && view.nodes.length === 0;
  return (
    <section className="screen" data-screen="graph">
      <div className="pane-head">
        <h2>Execution graph</h2>
        {flat && <span className="sub">one piece of work, not divided</span>}
        {view !== undefined && !flat && (
          <>
            <div className="graph-tools">
              <Button
                className="small"
                disabled={busy}
                onClick={() =>
                  void apply({
                    kind: "graphEdit",
                    edit: {
                      op: "add_node",
                      title: "New node",
                      criteria: [],
                      new_criteria: [
                        {
                          text: "New criterion: say what must be true.",
                          expected_verification: {
                            kind: "test",
                            assertion: "say how it is proven",
                          },
                        },
                      ],
                      paths: view.pathsAllowed.slice(0, 1),
                    },
                  })
                }
              >
                Node
              </Button>
              <Button
                className="small"
                disabled={busy || !one || one.criteria.length < 2}
                title={one && one.criteria.length < 2 ? "A split needs a criterion for each half" : ""}
                onClick={() => setSplitting(one?.id ?? null)}
              >
                Split…
              </Button>
              <Button
                className="small"
                disabled={busy || held.length !== 2}
                onClick={() =>
                  void apply({
                    kind: "graphEdit",
                    edit: { op: "merge_nodes", ids: [held[0]!, held[1]!] },
                  }).then(() => setSelected([held[0]!]))
                }
              >
                Merge
              </Button>
              <Button
                className="small"
                disabled={busy || !one}
                onClick={() => {
                  const rest = view.nodes.find((node) => node.id !== one?.id);
                  void apply({
                    kind: "graphEdit",
                    edit: {
                      op: "delete_node",
                      id: one!.id,
                      move_criteria_to: rest?.id ?? null,
                      delete_criteria: [],
                    },
                  }).then(() => setSelected([]));
                }}
              >
                Delete
              </Button>
            </div>
            {held.length > 1 ? (
              <span className="small muted">{held.length} selected</span>
            ) : (
              <GraphPopover
                label="How to work the canvas"
                trigger={{ className: "info-hint-dot", label: "How to work the canvas", body: "i" }}
              >
                shift-click two to merge · drag from ○ for an edge · drag the canvas to pan
              </GraphPopover>
            )}
            <span className="spacer" />
            <SizeEstimate size={view.size} />
          </>
        )}
      </div>
      {graph.error && <Notice tone="danger">{errorMessage(graph.error)}</Notice>}
      {failure !== null && <Notice tone="danger">{failure}</Notice>}
      {view !== undefined && flat && (
        <div className="graph-empty">
          <div className="ghost" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <h2>No graph yet</h2>
          <p>
            This plan is flat: its criteria are not grouped into nodes. Start over from the spec to
            draft a graph, or leave it flat — a flat plan is as valid as it ever was.
          </p>
        </div>
      )}
      {view !== undefined && !flat && (
        <>
          <Canvas
            view={view}
            changes={changes}
            selected={held}
            onSelect={setSelected}
            onEdge={(from, to) => void apply({ kind: "graphEdit", edit: { op: "add_edge", from, to } })}
            onRemoveEdge={(from, to) =>
              void apply({ kind: "graphEdit", edit: { op: "remove_edge", from, to } })
            }
          />
          <OutsidePaths outside={view.live.outside} note={view.live.note} />
          {one && (
            <GraphInspector
              key={one.id}
              view={view}
              node={one}
              changes={changes}
              live={view.live.nodes.find((node) => node.id === one.id)}
              busy={busy}
              apply={(edit) => apply({ kind: "graphEdit", edit })}
              onSplit={() => setSplitting(one.id)}
              onClose={() => setSelected([])}
            />
          )}
        </>
      )}
      {view !== undefined && (
        <>
          <ApproveBar
            view={view}
            workspace={workspace}
            history={view.history}
            busy={busy || action.isPending}
            thinking={thinking}
            onApprove={confirm}
            onUndo={(n) => void apply({ kind: "graphUndo", edit: n })}
            onStartOver={() => setStartingOver(true)}
          />
          {action.error && <Notice tone="danger">{errorMessage(action.error)}</Notice>}
        </>
      )}
      {splitting !== null && view?.nodes.some((node) => node.id === splitting) && (
        <SplitDialog
          node={view.nodes.find((node) => node.id === splitting)!}
          onClose={() => setSplitting(null)}
          onSplit={(edit) => {
            setSplitting(null);
            void apply({ kind: "graphEdit", edit }).then(() => setSelected([]));
          }}
        />
      )}
      {startingOver && (
        <Dialog title="Start over from the spec?" onClose={() => setStartingOver(false)}>
          <p>
            The drafter drafts a new contract and graph from this planning&rsquo;s spec, on the same
            task. The edits made to the plan since the last draft are dropped and stay in its
            history, marked replaced; the spec and its No-Gos are in the file, so they stay as they
            are.
          </p>
          <div className="dialog-actions">
            <Button autoFocus onClick={() => setStartingOver(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              disabled={busy || editor.submitting !== null}
              onClick={() => {
                setStartingOver(false);
                editor.submit("startOver");
              }}
            >
              Start over
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/**
 * A button and the panel it opens under it, which Close at the panel's right
 * edge shuts, and so does a press anywhere outside the two; the button's own
 * press is inside, so its click still toggles. The panel lines up with the
 * button's right edge and opens leftwards, which keeps it inside the pane the
 * button sits in.
 */
function GraphPopover({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: { className: string; label: string; body: ReactNode };
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div className="graph-pop-holder" ref={holder}>
      <button
        type="button"
        className={trigger.className}
        aria-expanded={open}
        aria-label={trigger.label}
        onClick={() => setOpen(!open)}
      >
        {trigger.body}
      </button>
      {open && (
        <div className="graph-pop" role="dialog" aria-label={label}>
          {children}
          <div className="graph-pop-foot">
            <Button className="small" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The size, S to XL, with the counts it came from and the ones that set it (D-104). */
function SizeEstimate({ size }: { size: GraphView["size"] }) {
  const word = {
    nodes: size.counts.nodes === 1 ? "node" : "nodes",
    criteria: size.counts.criteria === 1 ? "criterion" : "criteria",
    files: size.counts.files === 1 ? "file" : "files",
    packages: size.counts.packages === 1 ? "package" : "packages",
  };
  return (
    <GraphPopover
      label="How the size is worked out"
      trigger={{
        className: "size",
        label: `Size ${size.name}: how it is worked out`,
        body: (
          <>
            <span className="size-scale" aria-hidden="true">
              {SIZE_NAMES.map((name) => (
                <span key={name} className={cx(name === size.name && "on")}>
                  {name}
                </span>
              ))}
            </span>
            <span className="size-counts">
              {SIZE_COUNTS.map((count, index) => (
                <span key={count}>
                  {index > 0 ? " · " : ""}
                  <b className={cx(size.drivers.includes(count) && "drv")}>{size.counts[count]}</b>{" "}
                  {word[count]}
                </span>
              ))}
            </span>
          </>
        ),
      }}
    >
      <strong>Size {size.name}</strong>, from fixed thresholds on four counts. The plan takes the
      largest size any count reaches; the underlined counts set it. It describes the graph and
      predicts nothing.
      <table>
        <thead>
          <tr>
            <th />
            {SIZE_NAMES.map((name) => (
              <th key={name}>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SIZE_COUNTS.map((count) => (
            <tr key={count}>
              <td>
                {count} · {size.counts[count]}
              </td>
              {SIZE_THRESHOLDS.map((row) => (
                <td key={row.name}>≤{row[count]}</td>
              ))}
              <td>&gt;{SIZE_THRESHOLDS.at(-1)![count]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GraphPopover>
  );
}

/**
 * What one node's state reads as, and the record it came from (SCP-317). The
 * record is on the chip because a state nobody can trace is a claim, and every
 * one of these is a reading of a file the loop wrote. A node with nothing on
 * record — `untouched` — carries no chip: that is every node before the plan
 * has run, and a word on each of them says nothing.
 */
type ShownState = Exclude<GraphNodeState, "untouched">;
const NODE_STATE: Record<ShownState, { label: string; from: string }> = {
  finding_open: { label: "a finding open", from: "From the review artifact's findings." },
  checks_failed: {
    label: "checks failed",
    from: "From a pinned check narrowed to this node's own changed test files.",
  },
  covered: { label: "covered by review", from: "From the review artifact's evidence bindings." },
  checks_passed: {
    label: "checks passed",
    from: "From the pinned checks narrowed to this node's own changed test files.",
  },
  changed: { label: "changed", from: "From the sealed change set." },
};

function NodeState({ state }: { state: ShownState }) {
  return (
    <span className={cx("state", `state--${state}`)} title={NODE_STATE[state].from}>
      {NODE_STATE[state].label}
    </span>
  );
}

/**
 * The changed paths no node's globs match: work nobody planned for, said
 * rather than dropped. Empty for a plan that has not run and for a flat one,
 * which has no node for a path to be outside of.
 *
 * A note beside them rather than in place of them: one says why part of the
 * reading is missing, the other is a reading, and they are not alternatives.
 */
function OutsidePaths({ outside, note }: { outside: string[]; note: string | null }) {
  if (outside.length === 0 && note === null) return null;
  return (
    <section className="outside" aria-label="Changed outside every node">
      <span className="section-label">
        Changed outside every node · {outside.length}
      </span>
      {note !== null && <p className="small muted">{note}</p>}
      {outside.length > 0 && (
        <>
          <div className="path-chips">
            {outside.map((path) => (
              <span key={path} className="path-chip dashed">
                {path}
              </span>
            ))}
          </div>
          <p className="small muted">
            The sealed change set touched these and no node&rsquo;s paths name them. The review
            over the whole change is what covers them (D-107).
          </p>
        </>
      )}
    </section>
  );
}

/** The outside list, for a test that drives it without a whole plan behind it. */
export const OutsidePathsForTests = OutsidePaths;

/** Where one node's box sits inside the layer, measured after it has been laid out. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far the canvas zooms out and in. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

/**
 * The canvas: a clipping frame, and one layer inside it that moves. Dragging
 * the background or scrolling pans the layer, so a large graph is reachable
 * with the node panel open; dragging a node does not, because that is how an
 * edge is drawn. A trackpad pinch, which Chromium delivers as a wheel event
 * with `ctrlKey` set, and the scroll wheel with ⌃ or ⌘ held zoom the layer
 * about the pointer, between {@link ZOOM_MIN} and {@link ZOOM_MAX}.
 *
 * Read-only on the contract, where the graph is read and not curated: it pans
 * and zooms, and nothing on it selects, draws or removes
 * (D-NEW-basic-and-epic-flows).
 */
function Canvas({
  view,
  changes,
  selected,
  onSelect,
  onEdge,
  onRemoveEdge,
  readOnly = false,
}: {
  view: GraphView;
  /** The last change to the plan's promise, or null for none to mark. */
  changes: CriteriaChange | null;
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  onEdge: (from: string, to: string) => void;
  onRemoveEdge: (from: string, to: string) => void;
  readOnly?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => graphColumns(view.nodes, view.edges), [view.nodes, view.edges]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const at = useRef(pan);
  at.current = pan;
  const [zoom, setZoom] = useState(1);
  const scaled = useRef(zoom);
  scaled.current = zoom;
  const [grabbing, setGrabbing] = useState(false);
  const grab = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const moved = useRef(false);
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null);
  const drawn = useRef(drawing);
  drawn.current = drawing;
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [chosenEdge, setChosenEdge] = useState<string | null>(null);

  const panTo = useCallback((x: number, y: number) => setPan({ x, y }), []);
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    // Not passive: the canvas pans or zooms rather than the page scrolling or
    // the window zooming behind it.
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (!event.ctrlKey && !event.metaKey) {
        panTo(at.current.x - event.deltaX, at.current.y - event.deltaY);
        return;
      }
      // A pinch arrives as many small deltas and a wheel notch as one large
      // one, so a notch is capped to a step of about a quarter.
      const step = Math.max(-25, Math.min(25, event.deltaY));
      const from = scaled.current;
      const to = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, from * Math.exp(-step * 0.01)));
      if (to === from) return;
      // The layer point under the pointer stays under it. The layer is scaled
      // from its top-left corner, which sits at the pan offset from where it
      // is laid out; read from the refs, which are set here before the render,
      // so pinch events faster than the frames each start from the last one.
      const box = element.getBoundingClientRect();
      const x = event.clientX - (box.left + element.clientLeft + (layer.current?.offsetLeft ?? 0) + at.current.x);
      const y = event.clientY - (box.top + element.clientTop + (layer.current?.offsetTop ?? 0) + at.current.y);
      const keep = 1 - to / from;
      at.current = { x: at.current.x + x * keep, y: at.current.y + y * keep };
      scaled.current = to;
      setPan(at.current);
      setZoom(to);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [panTo]);
  useEffect(() => {
    if (!grabbing) return undefined;
    const move = (event: MouseEvent): void => {
      const from = grab.current;
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      panTo(from.panX + dx, from.panY + dy);
    };
    const up = (): void => setGrabbing(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [grabbing, panTo]);
  useEffect(() => {
    if (!drawing) return undefined;
    const move = (event: MouseEvent): void => {
      const box = layer.current?.getBoundingClientRect();
      if (!box) return;
      // In the layer's own coordinates, which the edges are drawn in.
      const x = (event.clientX - box.left) / scaled.current;
      const y = (event.clientY - box.top) / scaled.current;
      setDrawing((current) => (current ? { ...current, x, y } : current));
    };
    const up = (event: MouseEvent): void => {
      const held = drawn.current;
      setDrawing(null);
      const over = document.elementFromPoint(event.clientX, event.clientY);
      const target = over?.closest("[data-node]")?.getAttribute("data-node");
      if (held && target && target !== held.from) onEdge(held.from, target);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drawing !== null, onEdge]);

  /** The boxes, read back from the laid-out nodes, so the edges join what is drawn. */
  const measure = useCallback(() => {
    const root = layer.current;
    if (!root) return;
    const found: Record<string, Box> = {};
    for (const element of root.querySelectorAll<HTMLElement>("[data-node]")) {
      const column = element.parentElement;
      found[element.dataset["node"] ?? ""] = {
        x: (column?.offsetLeft ?? 0) + element.offsetLeft,
        y: (column?.offsetTop ?? 0) + element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
    }
    setBoxes((current) => (JSON.stringify(current) === JSON.stringify(found) ? current : found));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const curves = view.edges.flatMap((edge) => {
    const from = boxes[edge.from];
    const to = boxes[edge.to];
    if (!from || !to) return [];
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x - 3;
    const y2 = to.y + to.height / 2;
    const bend = Math.max(28, (x2 - x1) * 0.5);
    return [
      {
        id: `${edge.from}->${edge.to}`,
        from: edge.from,
        to: edge.to,
        d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
      },
    ];
  });
  const chosen = curves.find((curve) => curve.id === chosenEdge);

  const choose = (id: string, event: { shiftKey: boolean }): void => {
    onSelect(
      event.shiftKey
        ? selected.includes(id)
          ? selected.filter((each) => each !== id)
          : [...selected, id].slice(-2)
        : selected.length === 1 && selected[0] === id
          ? []
          : [id],
    );
    setChosenEdge(null);
  };
  return (
    <div
      className={cx("canvas", grabbing && "panning", drawing && "connecting")}
      role="group"
      aria-label="Execution graph canvas"
      ref={frame}
      onMouseDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest("[data-node], .handle, .edge-hit, .edge-x")
        )
          return;
        grab.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        moved.current = false;
        setGrabbing(true);
      }}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onSelect([]);
        setChosenEdge(null);
      }}
    >
      <div
        className="canvas-inner"
        ref={layer}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
      >
        <svg className="edges" width="100%" height="100%" aria-hidden="true">
          <defs>
            <marker
              id="graph-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,1 L9,5 L0,9 z" className="arrow" />
            </marker>
          </defs>
          {curves.map((curve) => (
            <g key={curve.id}>
              <path
                className={cx("edge", chosenEdge === curve.id && "sel")}
                d={curve.d}
                markerEnd="url(#graph-arrow)"
              />
              {!readOnly && (
                <path
                  className="edge-hit"
                  d={curve.d}
                  onClick={(event) => {
                    event.stopPropagation();
                    setChosenEdge(curve.id);
                    onSelect([]);
                  }}
                >
                  <title>Click to select this edge</title>
                </path>
              )}
            </g>
          ))}
          {drawing && (
            <path
              className="edge temp"
              d={`M${(boxes[drawing.from]?.x ?? 0) + (boxes[drawing.from]?.width ?? 0)},${
                (boxes[drawing.from]?.y ?? 0) + (boxes[drawing.from]?.height ?? 0) / 2
              } L${drawing.x},${drawing.y}`}
            />
          )}
        </svg>
        {columns.map((column, index) => (
          <div className="col" key={index}>
            {column.flatMap((id) => {
              const node = view.nodes.find((each) => each.id === id);
              return node
                ? [
                    <Node
                      key={id}
                      node={node}
                      changes={changes}
                      live={view.live.nodes.find((each) => each.id === id)}
                      selected={selected}
                      onChoose={readOnly ? null : choose}
                      onDraw={setDrawing}
                      boxes={boxes}
                    />,
                  ]
                : [];
            })}
          </div>
        ))}
        {chosen && (
          <button
            type="button"
            className="edge-x"
            style={{ left: `${chosen.x}px`, top: `${chosen.y}px` }}
            aria-label={`Remove the edge ${chosen.from} to ${chosen.to}`}
            onClick={(event) => {
              event.stopPropagation();
              setChosenEdge(null);
              onRemoveEdge(chosen.from, chosen.to);
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function Node({
  node,
  changes,
  live,
  selected,
  onChoose,
  onDraw,
  boxes,
}: {
  node: GraphNodeView;
  /** The last change to the plan's promise, or null for none to mark. */
  changes: CriteriaChange | null;
  live: GraphNodeLive | undefined;
  selected: readonly string[];
  /** What choosing the node does, or null where it is only read. */
  onChoose: ((id: string, event: { shiftKey: boolean }) => void) | null;
  onDraw: (drawing: { from: string; x: number; y: number }) => void;
  boxes: Record<string, Box>;
}) {
  const choosable = onChoose !== null;
  return (
    <div
      data-node={node.id}
      role={choosable ? "button" : "group"}
      tabIndex={choosable ? 0 : undefined}
      aria-pressed={choosable ? selected.includes(node.id) : undefined}
      aria-label={`Node ${node.id}: ${node.title}`}
      className={cx("node", selected.includes(node.id) && "selected")}
      onClick={(event) => {
        // The canvas clears the selection when the background is clicked, and
        // this is not the background.
        event.stopPropagation();
        onChoose?.(node.id, event);
      }}
      onKeyDown={(event) => {
        if (onChoose === null || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        onChoose(node.id, event);
      }}
    >
      <div className="node-head">
        <span className="node-label">{node.id}</span>
        <span className="node-title">{node.title}</span>
        {live && live.state !== "untouched" && <NodeState state={live.state} />}
      </div>
      <div className="node-summary small muted">{nodeSummary(node)}</div>
      {node.criteria.map((criterion) => (
        <div className="crit" key={criterion.id}>
          <span className={`kind kind--${criterion.kind}`}>{criterion.kind}</span>
          {/* Marked as the last change left it. A criterion the change took
              away belongs to no node now, so no card shows it; the inspector
              does, at the end of its list. */}
          <span>
            <MarkedCriterion text={criterion.text} change={changes?.of.get(criterion.id)} />
          </span>
        </div>
      ))}
      {live && live.changed.length > 0 && (
        <div className="node-changed" aria-label={`Changed under ${node.id}`}>
          {live.changed.map((path) => (
            <span key={path}>{path}</span>
          ))}
        </div>
      )}
      {choosable && <span
        className="handle"
        title="Drag to another node to draw an edge"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const box = boxes[node.id];
          onDraw({
            from: node.id,
            x: (box?.x ?? 0) + (box?.width ?? 0),
            y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
          });
        }}
        onClick={(event) => event.stopPropagation()}
      />}
    </div>
  );
}

/**
 * The plan's graph on the contract of an epic, in place of the criteria list:
 * read, panned and zoomed, and changed only on the Graph pane
 * (D-NEW-basic-and-epic-flows).
 */
export function ContractGraph({ repoId, ticketKey }: { repoId: string; ticketKey: string }) {
  const graph = useGraph(repoId, ticketKey);
  const none = useCallback(() => undefined, []);
  if (graph.error) return <Notice tone="danger">{errorMessage(graph.error)}</Notice>;
  if (!graph.data) return <p className="small muted">Reading the graph…</p>;
  return (
    <section className="contract-graph" aria-label="Execution graph">
      <Canvas
        view={graph.data}
        changes={null}
        selected={[]}
        onSelect={none}
        onEdge={none}
        onRemoveEdge={none}
        readOnly
      />
    </section>
  );
}

/**
 * What approving freezes, the edits made since the draft, and the approval
 * itself — on the fixed binding, producing the contract the runner reads
 * exactly as the contract screen does.
 */
function ApproveBar({
  view,
  workspace,
  history,
  busy,
  thinking,
  onApprove,
  onUndo,
  onStartOver,
}: {
  view: GraphView;
  workspace: Snapshot;
  history: GraphView["history"];
  busy: boolean;
  /** Whether the way onward waits for a turn in flight, which may still be moving this plan. */
  thinking: boolean;
  onApprove: () => void;
  onUndo: (n: number) => void;
  onStartOver: () => void;
}) {
  const files = view.size.counts.files;
  const running = workspace.tasks.find((row) => row.ticket.state === "executing");
  const undoable = latestUndoable(graphHistory(history));
  return (
    <div className="approve-bar">
      <section className="graph-history" aria-label="Edits to this plan">
        <span className="section-label">
          Edits to this plan · {view.editCount} counted against admission
          {history.length > 6 ? ` · ${history.length - 6} more in History` : ""}
          {/* The two facts a person acts on: how much is in scope, and what is
              ahead of this in the queue. What approving freezes is stated on
              the contract, the page that freezes it and the page Confirm leads
              to, and repeating it here would cost a third of the canvas the
              plan is drawn on. */}
          {" · "}
          {files} {files === 1 ? "file" : "files"} in scope
          {running ? ` · starts after ${running.ticket.key}` : ""}
        </span>
        {history.length === 0 ? (
          <p className="small muted">Nothing has changed since the drafter proposed it.</p>
        ) : (
          <ol>
            {/* The last six, which is the two columns of three this bar is,
                rather than a scrollbox, which over columns fragments them
                sideways — more than two columns, and a bar a person has to
                scroll to read at a glance. History holds the whole record, and
                the count beside the label says how much of it is not here. */}
            {history.slice(-6).map((edit) => (
              <li key={edit.n} className={cx((edit.undone || edit.replaced) && "is-undone")}>
                <span className="hist-n">{edit.n}</span>
                <span className="hist-line">{edit.summary}</span>
                {edit.n === undoable?.n && (
                  <button
                    type="button"
                    className="text-button small"
                    disabled={busy}
                    aria-label={`Undo: ${edit.summary}`}
                    onClick={() => onUndo(edit.n)}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <div className="approve-actions">
        <button type="button" className="text-button small" disabled={busy} onClick={onStartOver}>
          Start over from the spec…
        </button>
        {/* The way onward says it is waiting rather than going quiet. */}
        {thinking && <span className="small muted">Waiting for the chat to finish this turn…</span>}
        <Button variant="primary" disabled={busy || thinking} onClick={onApprove}>
          {view.approved ? "Open the contract" : "Confirm the plan"}
        </Button>
      </div>
    </div>
  );
}
