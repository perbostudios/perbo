import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface ReplaceFileOptions {
  /** Permission bits of the new file, subject to the umask. Omitted: the default for a new file. */
  mode?: number;
}

/**
 * Replace `path` with `contents` in one step, or leave what is on disk alone.
 *
 * The bytes go to a temporary beside `path` that is this call's own —
 * `<path>.<pid>.<uuid>.tmp`, created exclusively — and a rename within the
 * directory swaps it in, so a reader sees the old file or the new one and never
 * half of either. A failure removes the temporary this call created and
 * rethrows, so the directory is left as it was found rather than holding the
 * remains of a write that did not land.
 *
 * It creates no directory: the caller owns where it writes. Nothing is fsynced,
 * which orders what a concurrent reader sees rather than what survives a power
 * cut.
 */
export function replaceFile(
  path: string,
  contents: string | Uint8Array,
  options: ReplaceFileOptions = {},
): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | null = null;
  let created = false;
  try {
    handle = openSync(temporary, "wx", options.mode ?? 0o666);
    // Exclusive creation succeeded, so these bytes are this call's to remove.
    // A name that was already taken is not, and removing it would delete a file
    // this call never wrote.
    created = true;
    writeFileSync(handle, contents);
    closeSync(handle);
    handle = null;
    renameSync(temporary, path);
  } catch (error) {
    if (handle !== null)
      try {
        closeSync(handle);
      } catch {
        // The descriptor is already gone, which is what closing it was for.
      }
    if (created) rmSync(temporary, { force: true });
    throw error;
  }
}
