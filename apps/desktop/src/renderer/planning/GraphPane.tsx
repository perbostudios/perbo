import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Notice, cx } from "../ui/index.js";
import { SIZE_COUNTS, SIZE_NAMES, SIZE_THRESHOLDS } from "@perbo/contracts/size";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import { bridge, errorMessage, useAction } from "../data.js";
import { isLive } from "../../shared/jobs.js";
import { useShortcut } from "../shell/shortcuts.js";
import { GraphInspector, SplitDialog } from "./GraphInspector.js";
import { graphColumns } from "./graph-layout.js";
import { graphHistory, latestUndoable } from "./history.js";
import type {
  Change,
  GraphNodeLive,
  GraphNodeState,
  GraphNodeView,
  GraphView,
  Job,
  Snapshot,
} from "../../shared/protocol.js";
import type { useContractEditing } from "../tasks/contract-editor.js";
import type { Route } from "../shell/App.js";

/**
 * The Graph pane (D-100, D-101, SCP-316): the plan's execution graph, the size
 * derived from it, and the one approval at the end of it.
 *
 * **The pane writes nothing.** Every change is one `GraphEdit` handed to the
 * host, which runs `perbo edit --graph-edit` — the same command the interview
 * uses — so each edit is validated whole, recorded with its author and
 * undoable, and the contract and the approach record are only ever written by
 * that command. What the pane holds is a selection and a pan offset.
 *
 * The drawing is its own: positioned nodes and an SVG layer of edges, because
 * the renderer runs under a policy that allows no worker and no remote origin
 * ({@link ../../../index.html}).
 */

type Editor = ReturnType<typeof useContractEditing>;

/** The job a request started, once it has stopped running. */
function useSettled(): (job: Job) => Promise<Job> {
  const done = useRef(new Map<string, Job>());
  const waiting = useRef(new Map<string, (job: Job) => void>());
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        const job = "job" in change ? change.job : undefined;
        if (!job || isLive(job)) return;
        done.current.set(job.id, job as Job);
        waiting.current.get(job.id)?.(job as Job);
        waiting.current.delete(job.id);
      }),
    [],
  );
  return useCallback((job: Job) => {
    if (!isLive(job)) return Promise.resolve(job);
    const already = done.current.get(job.id);
    if (already) return Promise.resolve(already);
    return new Promise<Job>((resolve) => waiting.current.set(job.id, resolve));
  }, []);
}

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

  const graph = useQuery({
    queryKey: ["graph", repoId, key],
    queryFn: () => bridge.request({ kind: "graphRead", repoId, key: key ?? "" }),
    networkMode: "always",
    enabled: key !== null,
    staleTime: 1000,
  });
  const view: GraphView | undefined = graph.data;

  /**
   * The records this pane reads are written while a run moves, so the pane
   * follows them (D-100): one that refreshed only on its own edits would show
   * the run as it stood when it was opened. A run's progress arrives many
   * times a minute and each read walks the repository's bundle store, so it is
   * taken at most once a second, and the last one is never dropped.
   */
  useEffect(() => {
    if (key === null) return undefined;
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const take = (): void => {
      at = Date.now();
      timer = null;
      void client.invalidateQueries({ queryKey: ["graph", repoId, key] });
    };
    const stop = bridge.subscribe((change: Change) => {
      const job = "job" in change ? change.job : undefined;
      const mine =
        change.kind === "records"
          ? change.repoId === null || change.repoId === repoId
          : change.kind === "progress" && (job?.key === key || job?.resultKey === key);
      if (!mine || timer !== null) return;
      const since = Date.now() - at;
      if (since >= 1000) take();
      else timer = setTimeout(take, 1000 - since);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      stop();
    };
  }, [client, key, repoId]);

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
  const one = held.length === 1 ? view?.nodes.find((node) => node.id === held[0]) : undefined;
  const approve = (): void => {
    if (view === undefined || busy || action.isPending) return;
    void action
      .mutateAsync({
        kind: "run",
        repoId,
        key: view.key,
        digest: view.digest,
        approve: !view.approved,
        publish: false,
        resumeFrom: null,
      })
      .then(() => navigate({ page: "task", repoId, key: view.key, view: "loop" }))
      .catch(() => undefined);
  };
  useShortcut("approve", view === undefined || busy || action.isPending ? null : approve);

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
            <span className="small muted">
              {held.length > 1
                ? `${held.length} selected`
                : "shift-click two to merge · drag from ○ for an edge · drag the canvas to pan"}
            </span>
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
            onApprove={approve}
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
              disabled={busy || editor.submitting}
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

/** The size, S to XL, with the counts it came from and the ones that set it (D-104). */
function SizeEstimate({ size }: { size: GraphView["size"] }) {
  const [open, setOpen] = useState(false);
  const word = {
    nodes: size.counts.nodes === 1 ? "node" : "nodes",
    criteria: size.counts.criteria === 1 ? "criterion" : "criteria",
    files: size.counts.files === 1 ? "file" : "files",
    packages: size.counts.packages === 1 ? "package" : "packages",
  };
  return (
    <div className="size-holder">
      <button
        type="button"
        className="size"
        aria-expanded={open}
        aria-label={`Size ${size.name}: how it is worked out`}
        onClick={() => setOpen(!open)}
      >
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
      </button>
      {open && (
        <div className="size-pop" role="dialog" aria-label="How the size is worked out">
          <strong>Size {size.name}</strong>, from fixed thresholds on four counts. The plan takes
          the largest size any count reaches; the underlined counts set it. It describes the graph
          and predicts nothing.
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
          <Button className="small" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What one node's state reads as, and the record it came from (SCP-317). The
 * record is on the chip because a state nobody can trace is a claim, and every
 * one of these is a reading of a file the loop wrote.
 */
const NODE_STATE: Record<GraphNodeState, { label: string; from: string }> = {
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
  untouched: { label: "untouched", from: "From the sealed change set: no path here matches." },
};

function NodeState({ state }: { state: GraphNodeState }) {
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

/**
 * The canvas: a clipping frame, and one layer inside it that moves. Dragging
 * the background or scrolling pans the layer, so a large graph is reachable
 * with the node panel open; dragging a node does not, because that is how an
 * edge is drawn.
 */
function Canvas({
  view,
  selected,
  onSelect,
  onEdge,
  onRemoveEdge,
}: {
  view: GraphView;
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  onEdge: (from: string, to: string) => void;
  onRemoveEdge: (from: string, to: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => graphColumns(view.nodes, view.edges), [view.nodes, view.edges]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const at = useRef(pan);
  at.current = pan;
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
    // Not passive: the canvas pans rather than the page scrolling behind it.
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      panTo(at.current.x - event.deltaX, at.current.y - event.deltaY);
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
      setDrawing((current) =>
        current ? { ...current, x: event.clientX - box.left, y: event.clientY - box.top } : current,
      );
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
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
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
                      live={view.live.nodes.find((each) => each.id === id)}
                      selected={selected}
                      onChoose={choose}
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
  live,
  selected,
  onChoose,
  onDraw,
  boxes,
}: {
  node: GraphNodeView;
  live: GraphNodeLive | undefined;
  selected: readonly string[];
  onChoose: (id: string, event: { shiftKey: boolean }) => void;
  onDraw: (drawing: { from: string; x: number; y: number }) => void;
  boxes: Record<string, Box>;
}) {
  return (
    <div
      data-node={node.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected.includes(node.id)}
      aria-label={`Node ${node.id}: ${node.title}`}
      className={cx("node", selected.includes(node.id) && "selected")}
      onClick={(event) => {
        // The canvas clears the selection when the background is clicked, and
        // this is not the background.
        event.stopPropagation();
        onChoose(node.id, event);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onChoose(node.id, event);
      }}
    >
      <div className="node-head">
        <span className="node-label">{node.id}</span>
        <span className="node-title">{node.title}</span>
        {live && <NodeState state={live.state} />}
      </div>
      {node.criteria.map((criterion) => (
        <div className="crit" key={criterion.id}>
          <span className={`kind kind--${criterion.kind}`}>{criterion.kind}</span>
          <span>{criterion.text}</span>
        </div>
      ))}
      <div className="node-paths">{node.paths.join(" · ")}</div>
      {live && live.changed.length > 0 && (
        <div className="node-changed" aria-label={`Changed under ${node.id}`}>
          {live.changed.map((path) => (
            <span key={path}>{path}</span>
          ))}
        </div>
      )}
      <span
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
      />
    </div>
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
  onApprove,
  onUndo,
  onStartOver,
}: {
  view: GraphView;
  workspace: Snapshot;
  history: GraphView["history"];
  busy: boolean;
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
        </span>
        {history.length === 0 ? (
          <p className="small muted">Nothing has changed since the drafter proposed it.</p>
        ) : (
          <ol>
            {history.map((edit) => (
              <li key={edit.n} className={cx((edit.undone || edit.replaced) && "is-undone")}>
                <span className="hist-n">{edit.n}</span>
                <span className="hist-line">{edit.summary}</span>
                <small className={`author author--${edit.author}`}>
                  {edit.author === "you" ? "you" : "the interview"}
                </small>
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
      <p>
        <b>Approving freezes</b> the outcome and each node&rsquo;s criteria and paths ({files}{" "}
        {files === 1 ? "file" : "files"} in scope) and the base. The order between nodes and the
        spec&rsquo;s No-Gos stay approach, and may still change while the work runs.
        {running ? ` Runs go one at a time; this one starts after ${running.ticket.key}.` : ""}
      </p>
      <div className="approve-actions">
        <button type="button" className="text-button small" disabled={busy} onClick={onStartOver}>
          Start over from the spec…
        </button>
        <Button variant="primary" disabled={busy} onClick={onApprove}>
          {view.approved ? "Start the loop" : "Approve · start the loop"}
        </Button>
      </div>
    </div>
  );
}
