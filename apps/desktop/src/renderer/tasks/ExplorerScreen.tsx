import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, LineIcon, cx } from "../ui/index.js";
import { bridge } from "../workspace/index.js";
import { covers, nodesNaming, treeRows } from "../planning/explorer-tree.js";
import { planNodes } from "@perbo/contracts/browser";
import type { TaskContext } from "./task-context.js";

/**
 * The repository's files beside a compiled contract, to read and not to mark.
 *
 * The planning Explorer is where a scope is made: it marks paths into the
 * draft a contract is compiled from. This is the other question — what is in
 * the scope this contract already carries — and it is asked from the contract
 * itself, where a person is deciding whether to freeze it.
 *
 * It is deliberately read-only, and that is not timidity. A mark here would
 * write the editing session's draft and reach the contract only through a
 * re-compile, while approval freezes the contract and sends the contract
 * file's digest — which a mark never changes. The freeze would pass, the mark
 * would be left behind, and nothing would have said so. Marking belongs where
 * a compile follows it, so the scope row's link goes to planning instead.
 *
 * Nothing here opens an editing session. `explorerList` and `explorerRead`
 * take a repository id and nothing else, so a ticket the CLI admitted — one
 * that never had a session — browses exactly like one that did.
 */

/** Whether the contract's scope reaches a row, by the globs it actually holds. */
function reach(
  globs: readonly string[],
  path: string,
): { covered: boolean; by: string | null } {
  const by = globs.find((glob) => covers(glob, path)) ?? null;
  return { covered: by !== null, by };
}

export function ExplorerScreen(context: TaskContext) {
  const { detail, repoId, workspace, show } = context;
  const { contract } = detail;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
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
  });
  const files = useMemo(() => listing.data?.files ?? [], [listing.data]);
  const rows = useMemo(() => treeRows(files, open, query), [files, open, query]);
  const nodes = planNodes(contract);
  const allowed = contract.scope.paths_allowed;
  const prohibited = contract.scope.paths_prohibited;

  const select = (path: string, dir: boolean): void => {
    setSelected(path);
    if (!dir) return;
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };

  const inScope = selected === null ? null : reach(allowed, selected);
  const refused = selected === null ? null : reach(prohibited, selected);

  return (
    <section className="screen" data-screen="explorer">
      <div className="pane-head">
        <h2>Files</h2>
        <span className="sub">
          {listing.data ? `${files.length} tracked files` : "reading the repository…"}
        </span>
        <span className="spacer" />
        <Button className="small" onClick={() => show("contract")}>
          Back to the contract
        </Button>
      </div>
      <div className="explorer">
        <div className="explorer-side">
          <div className="filter">
            <input
              aria-label="Filter files"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="tree" role="tree" aria-label="Tracked files">
            {rows.map((row) => {
              const within = reach(allowed, row.path);
              const out = reach(prohibited, row.path);
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
                    !within.covered && "out-of-scope",
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
                  {out.covered ? (
                    <span className="mark-chip is-prohibited">off limits</span>
                  ) : within.covered ? (
                    <span className="mark-chip is-allowed">in scope</span>
                  ) : null}
                  {tags.length > 0 && (
                    <span className="node-tag" title={tags.map((node) => node.title).join(", ")}>
                      {tags.map((node) => node.id).join(" ")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <section className="standing" aria-label="This contract's scope">
            <span className="section-label">This contract&rsquo;s scope</span>
            {allowed.map((glob) => (
              <div key={glob} className="standing-row">
                <span>{glob}</span>
                <small>allowed</small>
              </div>
            ))}
            {prohibited.map((glob) => (
              <div key={`no:${glob}`} className="standing-row">
                <LineIcon name="lock" size={12} />
                <span>{glob}</span>
                <small>off limits</small>
              </div>
            ))}
          </section>
          <p className="hidden-note">
            {listing.data?.hidden ?? 0} paths never appear here: secrets, .git and agent
            configuration. Marking a path is done where a compile follows it, in the planning
            this contract was drafted from.
          </p>
        </div>
        <div className="preview">
          {selected === null ? (
            <div className="folder-sum">
              Select a file to read it. The preview is read-only: Perbo has no code editor, and
              editing code stays in your own. What a row says is whether{" "}
              {repository?.name ?? "this repository"}&rsquo;s contract reaches it.
            </div>
          ) : (
            <>
              <div className="preview-head">
                <div className="preview-path">
                  <span className="mono">{selected}</span>
                  {refused?.covered ? (
                    <span className="mark-chip is-prohibited">
                      off limits{refused.by === selected ? "" : ` · ${refused.by}`}
                    </span>
                  ) : inScope?.covered ? (
                    <span className="mark-chip is-allowed">
                      in scope{inScope.by === selected ? "" : ` · ${inScope.by}`}
                    </span>
                  ) : (
                    <span className="mark-chip">outside the scope</span>
                  )}
                </div>
              </div>
              {selected.endsWith("/") ? (
                <div className="folder-sum">
                  A folder. What the contract says about it is on the row beside it.
                </div>
              ) : file.data?.refusal ? (
                <div className="folder-sum">{file.data.refusal}</div>
              ) : file.data?.text == null ? (
                <div className="folder-sum">
                  {file.isFetching ? "Reading…" : "Nothing to show for this path."}
                </div>
              ) : (
                <pre className="file-body">
                  {file.data.text.split("\n").map((line, at) => (
                    <div key={at} className="file-line">
                      <span className="file-no">{at + 1}</span>
                      <span>{line}</span>
                    </div>
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
