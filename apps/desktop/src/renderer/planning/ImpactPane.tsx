import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, LineIcon, Notice } from "../ui/index.js";
import { withNoGo } from "@perbo/planning/impact";
import type { ImpactReasonKind, ImpactWarning } from "@perbo/planning/impact";
import { bridge, errorMessage } from "../workspace/index.js";
import type { ImpactView, Snapshot } from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The Impact pane (D-015, D-101): what this draft is likely to touch that its
 * scope does not cover.
 *
 * **On demand, and that means a button.** The answer is a fresh `perbo index`
 * over the repository's whole tracked tree, so opening the pane shows what was
 * asked for last and asks for nothing; the person asks, and asks again when the
 * draft has moved.
 *
 * **A warning is advice.** Nothing on this screen reaches a contract, a scope
 * glob or a spec on its own (ADR-0023 §4). The two actions beside a warning are
 * the two writers that already exist: **Add to scope** is the draft's own mark,
 * the one the Explorer makes, so it lands in the draft's history with an undo;
 * **Add as a No-Go** is the spec's own save, so it lands in the file the Spec
 * pane reads back.
 */

/** What each reason is called on a chip. The sentence beside it is the report's own. */
const REASON_LABELS: Record<ImpactReasonKind, string> = {
  imports_scope: "imports the scope",
  imports_named: "imports what the spec names",
  named: "named by the spec",
  migration: "migration",
  dependency: "dependency",
  config: "configuration",
  security: "security",
  ci_infra_policy: "CI, infra or policy",
};

export function ImpactPane({ workspace, editor }: { workspace: Snapshot; editor: Editor }) {
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const session = editor.session;
  const repository = workspace.repositories.find((entry) => entry.id === editor.repoId);

  const impact = useQuery({
    queryKey: ["impact", session?.id ?? ""],
    queryFn: () => bridge.request({ kind: "impactRead", id: session!.id }),
    networkMode: "always",
    // Asked for, never standing: the pane opens on what the last ask returned.
    enabled: asked && session !== null,
    // `staleTime` alone holds a *loaded* answer still on window focus. It does
    // not hold a failed one: `isStaleByTime` treats undefined data as stale
    // regardless of `staleTime`, and a rejected ask never has data, so
    // `refetchOnWindowFocus` must be off too or a failed ask would run `git
    // ls-files` and a full `perbo index` again on every focus.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const view: ImpactView | undefined = impact.data;

  /** The draft's own mark, the one the Explorer makes, so the history can reverse it. */
  const toScope = useMutation({
    mutationFn: (path: string) =>
      bridge.request({
        kind: "explorerMark",
        id: session!.id,
        revision: session!.revision,
        path,
        mark: "allowed",
        always: null,
      }),
    onSuccess: () => setFailure(null),
    onError: (error: unknown) => setFailure(errorMessage(error)),
  });

  /** The spec's own save, so the No-Go lands in the file the Spec pane reads back. */
  const toNoGo = useMutation({
    mutationFn: async (path: string) => {
      const spec = await bridge.request({ kind: "specRead", id: session!.id });
      if (spec.slug === null)
        throw new Error(
          "This planning has no spec yet. Give it a title in the Spec pane, and its No-Gos are a section of the file.",
        );
      return bridge.request({
        kind: "specSave",
        id: session!.id,
        repoId: editor.repoId,
        title: spec.title,
        sections: { ...spec.sections, no_gos: withNoGo(spec.sections.no_gos, path) },
        // What this save is against: the Spec pane or the interview may have
        // written the file since this pane read it, and a save that could not
        // say so would silently overwrite them (SCP-321).
        base: { title: spec.title, sections: spec.sections },
      });
    },
    onSuccess: async (reply) => {
      // The file is what the pane shows, refused or not: after a refusal it is
      // the other writer's text, which this action read stale against.
      client.setQueryData(["spec", session!.id], reply.view);
      if (reply.conflicting.length > 0) {
        // Nothing was written: the No-Gos section moved between this action's
        // read and its save. Asking again reads the file fresh.
        setFailure(
          "Nothing was saved: the No-Gos section changed elsewhere since this was read. " +
            "Add as a No-Go again to try against the current file.",
        );
        return;
      }
      setFailure(null);
    },
    onError: (error: unknown) => setFailure(errorMessage(error)),
  });

  if (!session)
    return (
      <section className="screen" data-screen="impact">
        <div className="pane-head">
          <h2>Impact</h2>
        </div>
        <p className="small muted">Opening this planning…</p>
      </section>
    );

  const check = (): void => {
    setFailure(null);
    setAsked(true);
    void client.invalidateQueries({ queryKey: ["impact", session.id] });
  };
  const groups = [...new Set((view?.warnings ?? []).map((warning) => warning.package))];
  // An empty scope is a ticketless run's `**`, not nothing named, so it reads as the repository.
  const scopeText = (checked: readonly string[]): string =>
    checked.length === 0 ? "the whole repository" : checked.join(", ");

  return (
    <section className="screen" data-screen="impact">
      <div className="pane-head">
        <h2>Impact</h2>
        <span className="sub">
          {repository ? `${repository.name} · ` : ""}
          {impact.isFetching
            ? "reading the repository…"
            : view
              ? `${view.warnings.length} outside this draft's scope`
              : "not checked yet"}
        </span>
        <span className="spacer" />
        {view && !impact.isFetching && (
          <span className="small muted">
            checked {new Date(view.readAt).toLocaleTimeString()}
            {view.index.commit === null ? "" : ` against ${view.index.commit.slice(0, 7)}`}
          </span>
        )}
        <Button variant={view ? "secondary" : "primary"} onClick={check} disabled={impact.isFetching}>
          {view ? "Check again" : "Check impact"}
        </Button>
      </div>
      {impact.error && <Notice tone="danger">{errorMessage(impact.error)}</Notice>}
      {failure && <Notice tone="danger">{failure}</Notice>}
      <div className="impact">
        {view === undefined ? (
          <EmptyState
            icon={<LineIcon name="impact" size={28} />}
            title={impact.isFetching ? "Reading the repository…" : "Nothing checked yet"}
            action={
              impact.isFetching ? undefined : (
                <Button variant="primary" onClick={check}>
                  Check impact
                </Button>
              )
            }
          >
            Impact reads the repository&rsquo;s imports and its path classes and lists what this
            draft is likely to touch that its scope does not cover. Asking changes neither the
            draft nor the spec: it rebuilds the index file perbo index keeps at
            .perbo/index.json, and every warning stays advice until you act on it.
          </EmptyState>
        ) : (
          <>
            {view.index.note && <p className="impact-note">{view.index.note}</p>}
            {view.warnings.length === 0 ? (
              <p className="impact-note">
                Nothing outside this draft&rsquo;s scope imports what it changes, and no path class
                it reaches sits outside it. Checked against {scopeText(view.scope)}.
              </p>
            ) : (
              groups.map((group) => (
                <section className="impact-group" key={group} aria-label={group}>
                  <span className="section-label">{group}</span>
                  {view.warnings
                    .filter((warning) => warning.package === group)
                    .map((warning) => (
                      <Warning
                        key={warning.path}
                        warning={warning}
                        busy={toScope.isPending || toNoGo.isPending}
                        onScope={() => toScope.mutate(warning.path)}
                        onNoGo={() => toNoGo.mutate(warning.path)}
                      />
                    ))}
                </section>
              ))
            )}
            {view.truncated > 0 && (
              <p className="impact-note">
                {view.truncated} more are not listed. These are the first by path and not the most
                serious ones: narrow the draft&rsquo;s scope, or read the rest in your editor.
              </p>
            )}
            <p className="hidden-note">
              Checked against {scopeText(view.scope)}
              {view.named.paths.length > 0 || view.named.symbols.length > 0
                ? ` and what the spec names: ${[...view.named.paths, ...view.named.symbols.map((name) => `@${name}`)].join(", ")}`
                : ""}
              . Secrets, .git and agent configuration never appear here.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** One path, every reason it is here, and the two ways to act on it. */
function Warning({
  warning,
  busy,
  onScope,
  onNoGo,
}: {
  warning: ImpactWarning;
  busy: boolean;
  onScope: () => void;
  onNoGo: () => void;
}) {
  return (
    <div className="impact-row" aria-label={warning.path}>
      <div className="impact-path">
        <LineIcon name="file" size={14} />
        <span>{warning.path}</span>
        {warning.reasons.map((reason) => (
          <span className="mark-chip mark--impact" key={reason.kind}>
            {REASON_LABELS[reason.kind]}
          </span>
        ))}
      </div>
      <ul className="impact-reasons">
        {warning.reasons.map((reason) => (
          <li key={reason.kind}>{reason.detail}</li>
        ))}
      </ul>
      <div className="impact-actions">
        <Button onClick={onScope} disabled={busy}>
          Add to scope
        </Button>
        <Button onClick={onNoGo} disabled={busy}>
          Add as a No-Go
        </Button>
      </div>
    </div>
  );
}
