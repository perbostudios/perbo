import { z } from "zod";
import { InterviewEventSchema } from "@perbo/contracts";
import { redact } from "../process.js";
import { INTERVIEWER_NAME } from "../../shared/protocol.js";
import type { InterviewEntry } from "../../shared/protocol.js";

type Line = InterviewEntry["line"];
type ToolLine = Extract<Line, { kind: "tool" }>;
type AskedLine = Extract<Line, { kind: "asked" }>;

/**
 * What one line of the interview's stdout means for the conversation.
 *
 * A reading, with no side effects: the host decides what to record and what to
 * tell, and this decides only what the line said.
 */
export type Relayed =
  | { kind: "line"; line: Line }
  /** A message carrying nothing to show: the chat is left as it is. */
  | { kind: "nothing" }
  /**
   * What the session said, redacted and clipped: the host decides whether it
   * is said now, held, or dropped, because that depends on what the turn does
   * next (D-102).
   */
  | { kind: "said"; text: string }
  /** The session admitted a write to the spec; the file lands as the call returns. */
  | { kind: "wroteSpec" }
  /** The session reported its own id, which `--session` continues (D-102). */
  | { kind: "started"; session: string; note: Line }
  /** A tool ran; `planMoved` where it wrote a plan edit the records now hold. */
  | { kind: "tool"; line: Omit<ToolLine, "edit">; planMoved: boolean }
  | { kind: "asked"; line: AskedLine }
  /** The session finished a turn, answering this many of the person's: the next word is theirs (D-119). */
  | { kind: "idle"; turns: number }
  /** The session is over, so nothing further is owed to the person. */
  | { kind: "ended"; line: Line };

/**
 * The text of one message the interview streamed, or null where it carries
 * none to show.
 *
 * A reading rather than a declaration: the messages travel as the Claude Agent
 * SDK shaped them, and the shapes are the provider's. Its `SDKAssistantMessage`
 * is `{ type: 'assistant', message: BetaMessage, … }`, whose `message` is
 * "Shaped like an Anthropic Messages API Message object (role 'assistant'):
 * id, model, content blocks (text, thinking, tool_use, ...)" — so what is read
 * is the text blocks, and a message that does not look like that shows nothing
 * rather than something guessed.
 */
const SdkAssistantSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  }),
});
export function interviewSaid(message: Record<string, unknown>): string | null {
  const parsed = SdkAssistantSchema.safeParse(message);
  if (!parsed.success) return null;
  const text = parsed.data.message.content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * One line of the interview's stdout, as the chat shows it.
 *
 * A line that does not parse is reported as one that did not parse: the line
 * itself is never relayed, because a host that passed unparsed output through
 * would be relaying whatever wrote it rather than the protocol it declared.
 *
 * Everything the session wrote is redacted and clipped on the way through, to
 * the caps the record holds: a line the record would refuse is the line lost,
 * and a note naming four hundred fields is the same loss again.
 */
export function relayed(line: string): Relayed {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      kind: "line",
      line: {
        kind: "note",
        text: "The chat wrote a line this build could not read: it is not JSON.",
      },
    };
  }
  const parsed = InterviewEventSchema.safeParse(raw);
  if (!parsed.success) {
    // The reason is the child's text like any other: redacted, and clipped,
    // because a line refused for four hundred fields names all four hundred
    // and a note the record will not hold is the line lost again.
    const why = redact(parsed.error.issues[0]?.message ?? "no reason given").slice(0, 2000);
    return {
      kind: "line",
      line: {
        kind: "note",
        text:
          "The chat wrote a line this build could not read: it is not one of the chat's " +
          `events (${why}).`,
      },
    };
  }
  const event = parsed.data;
  if (event.type === "started") {
    // The protocol caps the id at nothing and the record at 200, so it is
    // clipped here: unclipped, the append throws and the line that carries
    // the session is lost with it.
    const session = event.session_id.slice(0, 200);
    return {
      kind: "started",
      session,
      // The session's own id is of no use to anybody reading the chat, and the
      // spec's path is in the pane beside it; what is worth saying once is the
      // folder it may write that is on screen nowhere.
      note: {
        kind: "note",
        text: redact(`Writing ${event.spec} and ${event.adr}.`).slice(0, 2000),
      },
    };
  }
  if (event.type === "message") {
    const said = interviewSaid(event.message);
    return said === null ? { kind: "nothing" } : { kind: "said", text: redact(said).slice(0, 12_000) };
  }
  if (event.type === "refused")
    return {
      kind: "line",
      line: {
        kind: "refused",
        tool: event.tool.slice(0, 200),
        rule: event.rule.slice(0, 200),
        target: event.target === null ? null : redact(event.target).slice(0, 1000),
        reason: redact(event.reason).slice(0, 2000),
      },
    };
  if (event.type === "tool")
    return {
      kind: "tool",
      line: {
        kind: "tool",
        tool: event.tool.slice(0, 200),
        ok: event.ok,
        detail: redact(event.detail).slice(0, 12_000),
      },
      planMoved: event.ok && (event.tool === "edit_plan" || event.tool === "undo_edit"),
    };
  if (event.type === "idle") return { kind: "idle", turns: event.turns };
  if (event.type === "wrote_spec") return { kind: "wroteSpec" };
  if (event.type === "asked")
    return {
      kind: "asked",
      // Clipped the way every other field the session wrote is, and redacted:
      // this is the session's text and the person reads it.
      //
      // Whitespace is flattened on the way through for two reasons a reader
      // would not guess. A label goes back down as the person's turn and, in a
      // group of more than one part, one line of it — so a label with a newline
      // in it would compose an answer the dock could never read back, and the
      // group would be put again for ever. And redaction can empty a field
      // outright (a label that was only escape codes), which the record then
      // refuses for being empty, taking every question in the asking with it;
      // a named placeholder loses one label instead of all of them.
      line: {
        kind: "asked",
        groups: event.groups.map((group) => ({
          title: group.title === null ? null : said(group.title, 200, `${INTERVIEWER_NAME} asks`),
          parts: group.parts.map((part) => ({
            question: said(part.question, 600, "(the question did not survive redaction)"),
            options: part.options.map((option) => ({
              label: said(option.label, 200, "(unreadable answer)"),
              detail: option.detail === null ? null : said(option.detail, 600, "") || null,
              recommended: option.recommended,
            })),
          })),
        })),
      },
    };
  return {
    kind: "ended",
    line: {
      kind: "note",
      text: `The chat ended: ${redact(event.reason).slice(0, 2000)}.`,
    },
  };
}

/**
 * A model's text on its way to the person: redacted, its whitespace flattened
 * and clipped to what the field holds — as every line the interview relay
 * records is, so the same rule reads a question, an answer and a finding.
 * Empty where nothing survived, which the caller decides about: a field its
 * schema requires cannot be shown as nothing.
 */
export function readable(text: string, cap: number): string {
  return redact(text).replace(/\s+/g, " ").trim().slice(0, cap).trim();
}

const said = (text: string, cap: number, empty: string): string => {
  const kept = readable(text, cap);
  return kept.length > 0 ? kept : empty;
};
