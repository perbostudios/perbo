import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, Dropdown, IconButton, Notice } from "../ui/index.js";
import {
  ManifestEditorSchema,
  type ManifestEditor,
} from "../../shared/protocol.js";
import { bridge, errorMessage, useAction } from "../data.js";

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
  const [value, setValue] = useState<ManifestEditor | null>(null),
    [digest, setDigest] = useState("");
  const action = useAction();
  useEffect(() => {
    if (query.data && !value) {
      setValue(query.data.value);
      setDigest(query.data.digest);
    }
  }, [query.data, value]);
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
                      setValue({
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
                      setValue({
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
                      setValue({
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
                      setValue({
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
                          setValue({
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
              setValue({
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
              onChange={(event) =>
                setValue({
                  ...value,
                  offLimits: event.target.value
                    .split("\n")
                    .filter((path) => path.trim()),
                })
              }
            />
          </label>
          <p className="small muted">
            Existing approved contracts retain their scope. Repository
            protection also applies to new runs.
          </p>
        </>
      )}
      {action.error && (
        <Notice tone="danger">{errorMessage(action.error)}</Notice>
      )}
      <div className="row">
        <Button
          variant="primary"
          disabled={!valid.success || action.isPending}
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
