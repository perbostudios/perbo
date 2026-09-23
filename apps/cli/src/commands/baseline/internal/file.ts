import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../../../usage-error.js";
import { BaselineFileSchema, EMPTY_BASELINE_FILE, type BaselineFile } from "./stopwatch.js";

/**
 * `<store>/baseline.json` read and written (D-038, SCP-080).
 *
 * Separate from the command so that the E1 subcommands, which read a partner's
 * stopwatch entry to time a ticket, take the file from here rather than from
 * the module that dispatches them.
 */

export const BASELINE_FILENAME = "baseline.json";

export function baselinePath(storeDirectory: string): string {
  return join(storeDirectory, BASELINE_FILENAME);
}

export function readBaselineFile(path: string): BaselineFile {
  if (!existsSync(path)) return EMPTY_BASELINE_FILE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = BaselineFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a baseline record:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

export function writeBaselineFile(path: string, file: BaselineFile): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(BaselineFileSchema.parse(file), null, 2)}\n`);
}
