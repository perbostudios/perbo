import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, Dropdown, IconButton, Notice } from "../ui/index.js";
import {
  ManifestEditorSchema,
  TYPED_PATH_MAX_CHARS,
  type ManifestEditor,
} from "../../shared/protocol.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";

export function ManifestDialog({
  repoId,
  close,
}: {
  repoId: string;
  close: () => void;
}) {
  const query = useQuery({
    queryKey: ["manifest", repoId],
    queryFn: () => bridge.request({ kind: "manifest", repoId }),
    staleTime: 0,
  });
  // Only the person's own edit is held here. The read stays the query's, so a
  // reopened dialog shows the configuration as it is now rather than as it was
  // when this repository's entry was last filled.
  const [draft, setDraft] = useState<{ digest: string; value: ManifestEditor } | null>(null);
  const action = useAction();
  const read = query.data;
  const value = draft?.value ?? read?.value ?? null;
  const digest = draft?.digest ?? read?.digest ?? "";
  /** The configuration changed after the person started editing: saving would be refused. */
  const moved = draft !== null && read !== undefined && read.digest !== draft.digest;
  const edit = (next: ManifestEditor): void =>
    setDraft({ digest: draft?.digest ?? read!.digest, value: next });
  const valid = ManifestEditorSchema.safeParse(value);
  return (
    <Dialog title="Edit worktree manifest" onClose={close}>
      <p className="small muted">
        Choose the local files each worktree needs. Install and test commands
        stay pinned in the repository configuration.
      </p>
      {query.error && (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      )}
      {value && (
        <>
          <div className="manifest-entries">
            {value.entries.map((entry, index) => (
              <div className="outlined-card stack" key={index}>
                <div className="row">
                  <strong>File {index + 1}</strong>
                  <span className="spacer" />
                  <IconButton
                    icon="reject"
                    label={"Remove manifest entry " + (index + 1)}
                    onClick={() =>
                      edit({
                        ...value,
                        entries: value.entries.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  />
                </div>
                <label className="stack small">
                  Source in checkout
                  <input
                    aria-label={"Source " + (index + 1)}
                    value={entry.source_path}
                    onChange={(event) =>
                      edit({
                        ...value,
                        entries: value.entries.map((item, position) =>
                          position === index
                            ? { ...item, source_path: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label className="stack small">
                  Destination in worktree
                  <input
                    aria-label={"Destination " + (index + 1)}
                    value={entry.path}
                    onChange={(event) =>
                      edit({
                        ...value,
                        entries: value.entries.map((item, position) =>
                          position === index
                            ? { ...item, path: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <div className="row">
                  <Dropdown
                    aria-label={"Entry kind " + (index + 1)}
                    value={entry.kind}
                    onChange={(event) =>
                      edit({
                        ...value,
                        entries: value.entries.map((item, position) =>
                          position === index
                            ? {
                                ...item,
                                kind: event.target.value as
                                  | "file"
                                  | "directory",
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="file">File</option>
                    <option value="directory">Directory</option>
                  </Dropdown>
                  {(["secret", "required"] as const).map((key) => (
                    <label className="checkbox-row" key={key}>
                      <input
                        type="checkbox"
                        checked={entry[key]}
                        onChange={(event) =>
                          edit({
                            ...value,
                            entries: value.entries.map((item, position) =>
                              position === index
                                ? {
                                    ...item,
                                    [key]: event.target.checked,
                                    ...(key === "secret" && event.target.checked
                                      ? { strategy: "copy" as const }
                                      : {}),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                      {key}
                    </label>
                  ))}
                </div>
                <span className="small muted">
                  {entry.strategy === "symlink"
                    ? "Linked from the checkout"
                    : "Copied into the worktree"}{" "}
                  · {entry.reason}
                </span>
              </div>
            ))}
          </div>
          <button
            className="add-row"
            onClick={() =>
              edit({
                ...value,
                entries: [
                  ...value.entries,
                  {
                    path: "",
                    source_path: "",
                    kind: "file",
                    strategy: "copy",
                    secret: true,
                    required: true,
                    reason: "Selected by the engineer in Perbo",
                  },
                ],
              })
            }
          >
            + Add a local file
          </button>
          <label className="stack small">
            Additional off-limits paths · one glob per line
            <textarea
              aria-label="Off-limits paths"
              value={value.offLimits.join("\n")}
              onChange={(event) => {
                const lines = event.target.value.split("\n");
                // Each glob is held to what one holds where it is typed, as a
                // one-line field's own limit would hold it, so nothing typed is
                // refused when it is saved (D-NEW-nothing-shown-is-cut).
                if (lines.some((path) => path.length > TYPED_PATH_MAX_CHARS)) return;
                edit({
                  ...value,
                  offLimits: lines.filter((path) => path.trim()),
                });
              }}
            />
          </label>
          <p className="small muted">
            Existing approved contracts retain their scope. Repository
            protection also applies to new runs.
          </p>
        </>
      )}
      {moved && (
        <Notice tone="warning">
          The repository configuration changed after you started editing. Saving now would be
          refused.
        </Notice>
      )}
      {moved && (
        <Button onClick={() => setDraft(null)}>
          Start again from the current configuration
        </Button>
      )}
      {action.error && (
        <Notice tone="danger">{errorMessage(action.error)}</Notice>
      )}
      <div className="row">
        <Button
          variant="primary"
          disabled={!valid.success || moved || action.isPending}
          onClick={() => {
            if (valid.success)
              void action
                .mutateAsync({
                  kind: "saveManifest",
                  repoId,
                  digest,
                  value: valid.data,
                })
                .then(close)
                .catch(() => undefined);
          }}
        >
          Save manifest
        </Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </Dialog>
  );
}
