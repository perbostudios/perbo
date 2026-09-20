import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox, Notice, Segmented, cx } from "../ui/index.js";
import { standingGlob } from "@perbo/contracts/standing";
import { planNodes } from "@perbo/contracts/plan";
import { LineIcon } from "../icons.js";
import { bridge, errorMessage } from "../data.js";
import type { DraftMark } from "../../shared/contract-editing.js";
import type { Snapshot } from "../../shared/protocol.js";
import type { useContractEditing } from "../tasks/contract-editor.js";
import { nodesNaming, rowMark, treeRows, viaLabel, type RowMark } from "./explorer-tree.js";

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The Explorer pane (D-101, SCP-318): the repository's tracked files, one of
 * them read-only, and the marks that change the draft's own scope.
 *
 * It reads and never edits (D-015). A mark writes the draft's allowed and
 * prohibited paths, which admission passes as `--path` and `--prohibit`; the
 * always box writes the repository's standing list, which binds every ticket
 * here (D-105). Both go through the host, which resolves the path under the
 * registered repository and refuses anything it should not read.
 */
export function ExplorerPane({ workspace, editor }: { workspace: Snapshot; editor: Editor }) {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const session = editor.session;
  const repoId = editor.repoId;
  const repository = workspace.repositories.find((entry) => entry.id === repoId);
  const listing = useQuery({
    queryKey: ["explorer", repoId],
    queryFn: () => bridge.request({ kind: "explorerList", repoId }),
    networkMode: "always",
    enabled: repoId !== "",
    staleTime: 5000,
  });
  const file = useQuery({
    queryKey: ["explorer-file", repoId, selected],
    queryFn: () => bridge.request({ kind: "explorerRead", repoId, path: selected ?? "" }),
    networkMode: "always",
    enabled: selected !== null && !selected.endsWith("/"),
    staleTime: 30_000,
    retry: false,
  });

  const files = useMemo(() => listing.data?.files ?? [], [listing.data]);
  const standing = listing.data?.standing ?? [];
  const rows = useMemo(() => treeRows(files, open, query), [files, open, query]);
  const nodes = editor.record ? planNodes(editor.record.contract) : [];

  /** One mark, and the standing entry it moves, in one request the history can reverse. */
  const mark = async (path: string, next: DraftMark, always: boolean | null): Promise<void> => {
    if (!session) return;
    setRefusal(null);
    try {
      await bridge.request({
        kind: "explorerMark",
        id: session.id,
        revision: session.revision,
        path,
        mark: next,
        always,
      });
      await client.invalidateQueries({ queryKey: ["explorer", repoId] });
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  };
  const undo = async (edit: number): Promise<void> => {
    if (!session) return;
    setRefusal(null);
    try {
      await bridge.request({ kind: "explorerUndo", id: session.id, revision: session.revision, edit });
      await client.invalidateQueries({ queryKey: ["explorer", repoId] });
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  };

  if (!session)
    return (
      <section className="screen" data-screen="explorer">
        <div className="pane-head">
          <h2>Explorer</h2>
        </div>
        <p className="small muted">Opening this planning…</p>
      </section>
    );

  const marked = (path: string): RowMark => rowMark(session.form, standing, path);
  const selection = selected === null ? null : marked(selected);
  const locked = selection?.standing != null && selection.standing.draft !== session.id;
  // The always box is about this path's own entry. A file inside a folder the
  // list already covers is prohibited, and has nothing of its own to remove.
  const alwaysHere =
    selected === null
      ? null
      : (standing.find((entry) => entry.path === standingGlob(selected)) ?? null);
  const select = (path: string, dir: boolean): void => {
    setSelected(path);
    if (dir) setOpen(new Set([...open, path]));
  };

  return (
    <section className="screen" data-screen="explorer">
      <div className="pane-head">
        <h2>Explorer</h2>
        <span className="sub">
          {repository
            ? `${repository.name} · ${repository.branch} · ${repository.head.slice(0, 7)} · `
            : ""}
          {listing.data ? `${files.length} tracked files` : "reading the repository…"}
        </span>
        <span className="spacer" />
        <span className="mark-chip mark--allowed">allowed</span>
        <span className="mark-chip mark--prohibited">prohibited</span>
        <span className="mark-chip mark--standing">always</span>
      </div>
      {listing.error && <Notice tone="danger">{errorMessage(listing.error)}</Notice>}
      {refusal && <Notice tone="danger">{refusal}</Notice>}
      <div className="explorer">
        <div className="tree-col">
          <div className="tree-filter">
            <input
              aria-label="Filter files"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="tree" role="tree" aria-label="Tracked files">
            {rows.map((row) => {
              const state = marked(row.path);
              const tags = nodesNaming(nodes, row.path);
              const expanded = query.trim() !== "" || open.has(row.path);
              return (
                <div
                  key={row.path}
                  role="treeitem"
                  tabIndex={0}
                  aria-selected={selected === row.path}
                  aria-expanded={row.dir ? expanded : undefined}
                  className={cx(
                    "tree-row",
                    row.dir && "is-dir",
                    selected === row.path && "selected",
                    state.via && "inherited",
                  )}
                  style={{ paddingLeft: `${4 + row.depth * 14}px` }}
                  onClick={() => select(row.path, row.dir)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    select(row.path, row.dir);
                  }}
                >
                  {row.dir ? (
                    <span
                      className="chev"
                      data-open={expanded ? "true" : "false"}
                      onClick={(event) => {
                        event.stopPropagation();
                        const next = new Set(open);
                        if (next.has(row.path)) next.delete(row.path);
                        else next.add(row.path);
                        setOpen(next);
                      }}
                    >
                      <LineIcon name="chevron" size={12} strokeWidth={2} />
                    </span>
                  ) : (
                    <span className="chev" />
                  )}
                  <span className="name">
                    {row.name}
                    {row.dir ? "/" : ""}
                  </span>
                  <MarkChip mark={state} />
                  {tags.length > 0 && (
                    <span className="node-tag" title={tags.map((node) => node.title).join(", ")}>
                      {tags.map((node) => node.id).join(" ")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="tree-foot">
            {session.history.length > 0 && (
              <section className="draft-edits" aria-label="Marks in this draft">
                <span className="section-label">Marks in this draft</span>
                {session.history.map((edit) => (
                  <div key={edit.n} className={cx("edit-row", edit.undone && "is-undone")}>
                    <span>{edit.summary}</span>
                    {edit.undone ? (
                      <small>undone</small>
                    ) : (
                      <>
                        <small>{edit.author === "you" ? "you" : "the interview"}</small>
                        <button
                          type="button"
                          className="text-btn"
                          aria-label={`Undo: ${edit.summary}`}
                          onClick={() => void undo(edit.n)}
                        >
                          Undo
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </section>
            )}
            <section
              className="standing"
              aria-label={`Standing list for ${repository?.name ?? "this repository"}`}
            >
              <span className="section-label">Standing list</span>
              {standing.length === 0 ? (
                <p className="small muted">
                  Nothing is prohibited here for every ticket yet.
                </p>
              ) : (
                standing.map((entry) => (
                  <div key={entry.path} className="standing-row">
                    <LineIcon name="lock" size={12} />
                    <span>{entry.path}</span>
                    <small>{entry.source}</small>
                  </div>
                ))
              )}
            </section>
            <p className="hidden-note">
              {listing.data?.hidden ?? 0} paths never appear here: secrets, .git and agent
              configuration.
            </p>
          </div>
        </div>
        <div className="preview">
          {selected === null || selection === null ? (
            <div className="folder-sum">
              <h3>Nothing selected</h3>
              <p>
                Select a file to read it, or a folder to mark it. The preview is read-only:
                Perbo has no code editor, and editing code stays in your own.
              </p>
              <p>
                Marks belong to this draft. <b>Allowed</b> adds a path to the contract&rsquo;s
                scope. <b>Prohibited</b> keeps executors out even inside allowed paths; the write
                guard refuses the write. <b>Always prohibit</b> puts the path on this
                repository&rsquo;s standing list, for every ticket.
              </p>
            </div>
          ) : (
            <>
              <div className="preview-head">
                <div className="preview-path">
                  <LineIcon name={selected.endsWith("/") ? "explorer" : "file"} size={15} />
                  <span>{selected}</span>
                  {!selected.endsWith("/") && <span className="ro-chip">read-only</span>}
                  {nodesNaming(nodes, selected).length > 0 && (
                    <span className="node-tag">
                      named by node{" "}
                      {nodesNaming(nodes, selected)
                        .map((node) => node.id)
                        .join(", ")}
                    </span>
                  )}
                </div>
                {locked && selection.standing ? (
                  <div className="mark-controls">
                    <LineIcon name="lock" size={13} />
                    <span>
                      On this repository&rsquo;s standing list: {selection.standing.path} ·{" "}
                      {selection.standing.source}. Change it where it was written.
                    </span>
                  </div>
                ) : (
                  <div className="mark-controls">
                    <span>For this draft</span>
                    <Segmented
                      label="Mark for this draft"
                      value={selection.own ?? "unmarked"}
                      options={[
                        { value: "unmarked", label: "Unmarked" },
                        { value: "allowed", label: "Allowed" },
                        { value: "prohibited", label: "Prohibited" },
                      ]}
                      onChange={(value) => {
                        const next = value === "unmarked" ? null : (value as DraftMark);
                        void mark(
                          selected,
                          next,
                          next !== "prohibited" && alwaysHere !== null ? false : null,
                        );
                      }}
                    />
                    <Checkbox
                      checked={alwaysHere !== null}
                      onChange={(checked) =>
                        void mark(selected, checked ? "prohibited" : selection.own, checked)
                      }
                    >
                      Always prohibit in this repository
                    </Checkbox>
                    {selection.via && (
                      <span className="small mark-via-note">
                        Prohibited through {viaLabel(selection.via)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {selected.endsWith("/") ? (
                <FolderSummary files={files} path={selected} nodes={nodesNaming(nodes, selected).map((node) => node.id)} />
              ) : file.isPending ? (
                <div className="folder-sum">
                  <p>Reading {selected}…</p>
                </div>
              ) : file.error ? (
                <div className="folder-sum">
                  <Notice tone="danger">{errorMessage(file.error)}</Notice>
                </div>
              ) : file.data?.text === null ? (
                <div className="folder-sum">
                  <p>{file.data.refusal}</p>
                </div>
              ) : (
                <pre className="code" aria-label={`Contents of ${selected}`}>
                  {(file.data?.text ?? "")
                    .replace(/\n$/, "")
                    .split("\n")
                    .map((line, index) => (
                      <span key={index} className="l">
                        <span className="ln">{index + 1}</span>
                        {line}
                      </span>
                    ))}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** What one row says about its mark: its own, one inherited from a folder, or the repository's. */
function MarkChip({ mark }: { mark: RowMark }) {
  if (mark.standing)
    return (
      <span className="mark-chip mark--standing" title={mark.standing.source}>
        always
      </span>
    );
  if (mark.own === "prohibited") return <span className="mark-chip mark--prohibited">prohibited</span>;
  if (mark.own === "allowed") return <span className="mark-chip mark--allowed">allowed</span>;
  if (mark.via)
    return (
      <span className="mark-chip mark--via" title={`prohibited through ${mark.via}`}>
        via {viaLabel(mark.via)}
      </span>
    );
  return null;
}

/** A folder is marked, never read: what it holds, and which nodes name it. */
function FolderSummary({
  files,
  path,
  nodes,
}: {
  files: readonly string[];
  path: string;
  nodes: readonly string[];
}) {
  const inside = files.filter((file) => file.startsWith(path));
  return (
    <div className="folder-sum">
      <p>
        {inside.length} tracked {inside.length === 1 ? "file" : "files"}
        {nodes.length > 0 ? `, named by node ${nodes.join(", ")}` : ", named by no node"}.
      </p>
      <ul>
        {inside.slice(0, 14).map((file) => (
          <li key={file}>{file.slice(path.length)}</li>
        ))}
        {inside.length > 14 && <li>… {inside.length - 14} more</li>}
      </ul>
    </div>
  );
}
