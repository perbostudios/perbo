import { readObject } from "../records.js";
import { redact } from "../process.js";
import { objectPath } from "../repository/layout.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Detail, ReplyMap } from "../../shared/protocol.js";

/**
 * What one attempt retained, as the Output pane shows it: the transcript and
 * the change, read from the objects the run sealed.
 *
 * Read through the bundle the attempt itself recorded, so an artifact is shown
 * only where this ticket's own attempt sealed it: a bundle naming another
 * ticket shows nothing rather than another task's transcript. An object whose
 * bytes no longer hash to what was sealed is a note instead of the text, and so
 * is one that has grown past what the pane reads.
 */
export function retainedOutput(
  repo: RegisteredRepository,
  detail: Detail,
  attemptId?: string,
): ReplyMap["output"] {
  const attempt = attemptId
    ? detail.attempts.find((entry) => entry.id === attemptId)
    : detail.attempts.at(-1);
  if (attemptId && !attempt)
    throw new Error("The selected attempt does not belong to this task.");
  const bundle = attempt?.bundles.find(
    (bundle) =>
      bundle.kind === "execution" &&
      bundle.subject_id === attempt.id &&
      bundle.ticket_id === detail.ticket.ticket_id,
  );
  const notes: string[] = [];
  const read = (name: "transcript.jsonl" | "change.diff"): string | null => {
    const artifact = bundle?.artifacts.find((artifact) => artifact.name === name);
    if (!artifact?.retained) return null;
    const result = readObject(objectPath(repo, artifact.sha256), artifact);
    if (result.text === null) {
      notes.push(result.note);
      return null;
    }
    return redact(result.text);
  };
  return {
    transcript: read("transcript.jsonl"),
    diff: read("change.diff"),
    notes,
  };
}
