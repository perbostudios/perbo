import { useEffect, useState } from "react";
import { IconButton } from "../ui/index.js";

export function Rename({
  title,
  onSave,
  size = 15,
  open = false,
  onOpenChange,
}: {
  title: string;
  onSave: (title: string) => Promise<unknown>;
  size?: number;
  /** Opened from outside, for the rename shortcut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState(open),
    [value, setValue] = useState(title),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);
  useEffect(() => {
    if (open) setEditing(true);
  }, [open]);
  const close = (): void => {
    setEditing(false);
    onOpenChange?.(false);
  };
  const save = (): void => {
    if (value.trim())
      void onSave(value.trim())
        .then(close)
        .catch((error) => setError(String(error)));
  };
  return (
    <span className="rename" onClick={(event) => event.stopPropagation()}>
      {editing ? (
        <>
          <input
            autoFocus
            aria-label="Task name"
            value={value}
            maxLength={200}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") {
                close();
                setValue(title);
              }
            }}
          />
          <button className="text-button small" onClick={save}>
            Save
          </button>
          <span className="small muted">renaming · ↵ to save</span>
        </>
      ) : (
        <>
          <span>{title}</span>
          <IconButton
            icon="locked"
            size={size}
            label="Rename this task"
            onClick={() => {
              setEditing(true);
              onOpenChange?.(true);
            }}
          />
        </>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
