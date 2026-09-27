import { bridge } from "../workspace/index.js";
import { readingState } from "../../shared/contract-editing.js";
import { useTurnSending } from "./InterviewDock.js";
import type { Snapshot } from "../../shared/protocol.js";

/**
 * Whether the chat is still talking on this planning (D-102): a turn this
 * window sent is still on its way to the host, or the host says one is under
 * way. Generate plan, Confirm the plan and Confirm contract each wait for it,
 * so whatever the person last asked the chat for is in what the press reads.
 */
export function useChatTalking(workspace: Pick<Snapshot, "working">, sessionId: string | null | undefined): boolean {
  const sending = useTurnSending(sessionId ?? "");
  return sessionId != null && (sending || (workspace.working ?? []).includes(sessionId));
}

/**
 * The state a reading of this planning is of now, and the state its last
 * reading was of, read from the host at the moment a confirm asks rather than
 * off this window's copies (D-NEW-basic-and-epic-flows). A turn's edits reach
 * the host before it says the turn is over, and reach this window a round trip
 * later, so a confirm pressed the instant the turn ends compares the state the
 * turn left and never one read before its edits landed. Null where the
 * drafts list does not carry the planning.
 */
export async function readingNow(id: string): Promise<{ state: string; read: string | null } | null> {
  const [session, drafts] = await Promise.all([
    bridge.request({ kind: "editingRead", id }),
    bridge.request({ kind: "drafts" }),
  ]);
  const listed = drafts.find((draft) => draft.id === id);
  if (listed === undefined) return null;
  return { state: readingState(listed.spec, session.form.draft), read: listed.read };
}
