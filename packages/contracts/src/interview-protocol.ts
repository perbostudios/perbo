import { z } from "zod";

/**
 * What `perbo interview` reads on stdin and writes on stdout: one JSON object
 * per line, each side (D-102, SCP-311).
 *
 * Small and closed on purpose. It has two ends — the command writes it, and
 * planning mode's chat relays it (SCP-313) — so it lives here, where both read
 * one declaration of it. Going in are the person's turns; coming back are the
 * session's own messages, what its tools did and what the guard refused. Every
 * schema is strict, so a field neither side declared is a parse error rather
 * than something one end silently drops.
 *
 * The session's messages travel as its provider shaped them, under `message`.
 * They are the provider's shapes, not Perbo's, and pinning them here would be
 * a second declaration of somebody else's contract that drifts at their next
 * release. The one thing a reader may rely on across providers is what
 * {@link interviewSaidMessage} writes.
 */

/** One turn from the person. */
export const InterviewTurnSchema = z.strictObject({
  type: z.literal("turn"),
  text: z.string().min(1),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;

/** The session is running: where it writes, and how to find it again. */
export const InterviewStartedSchema = z.strictObject({
  type: z.literal("started"),
  session_id: z.string().min(1),
  /** The spec this interview writes, repository-relative. */
  spec: z.string().min(1),
  /** The ADR folder it may write, repository-relative. */
  adr: z.string().min(1),
  model: z.string().nullable(),
  /** The interview's own tools, named, so a host can label their cards. */
  tools: z.array(z.string().min(1)),
});

/** One message the session streamed, passed through. */
export const InterviewMessageSchema = z.strictObject({
  type: z.literal("message"),
  message: z.record(z.string(), z.unknown()),
});

/**
 * The session's own words, in the one shape every transport puts them in.
 *
 * More than one provider speaks here, and their message shapes are their own,
 * so what a reader can rely on is this: whatever said them, the words arrive as
 * an assistant message whose content is text blocks. A transport whose provider
 * already shapes them this way passes them through; one whose provider does not
 * builds them here, so there is one declaration of the shape rather than one
 * per transport.
 */
export function interviewSaidMessage(text: string): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** A call the guard refused. Reported, never put to the person as a question. */
export const InterviewRefusedSchema = z.strictObject({
  type: z.literal("refused"),
  tool: z.string().min(1),
  /** The admission rule that refused it, as the runner names it. */
  rule: z.string().min(1),
  target: z.string().nullable(),
  reason: z.string().min(1),
});

/** What one of the interview's own tools did. */
export const InterviewToolSchema = z.strictObject({
  type: z.literal("tool"),
  tool: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
});

/**
 * The most groups one asking carries, and the most parts and options in each.
 *
 * A limit rather than an allowance. A person sees only what needs them
 * ([D-001](../../../docs/11-open-decisions.md)), and putting a question cheaply
 * is not a reason to put more of them: a session with more to ask than this has
 * not yet worked out which of it the repository already answers. What is over
 * the bound is refused at the tool, so it is told and asks again with less
 * (D-117).
 */
export const MAX_QUESTION_GROUPS = 4;
export const MAX_QUESTION_PARTS = 4;
export const MAX_QUESTION_OPTIONS = 8;

/** One answer the person can pick rather than type. */
export const InterviewOptionSchema = z.strictObject({
  /** What the option says, which is the turn it sends when it is picked. */
  label: z.string().trim().min(1).max(200),
  /** What picking it means, where the label alone does not carry it. */
  detail: z.string().trim().max(600).nullable().default(null),
  /** The session's own recommendation, at most one to a part. */
  recommended: z.boolean().default(false),
});

/** One question, with the options it offers. */
export const InterviewQuestionPartSchema = z.strictObject({
  question: z.string().trim().min(1).max(600),
  options: z.array(InterviewOptionSchema).min(2).max(MAX_QUESTION_OPTIONS),
});

/**
 * Questions that belong together, put at once.
 *
 * A group is the unit the person is asked in: its parts are read together,
 * lettered a, b, c under one number, because a part whose answer depends on
 * another's is not a question that can be asked on its own. Groups are
 * independent of each other, which is what lets them be put one at a time.
 */
export const InterviewQuestionGroupSchema = z.strictObject({
  /** What binds the parts, where they need it. */
  title: z.string().trim().max(200).nullable().default(null),
  parts: z.array(InterviewQuestionPartSchema).min(1).max(MAX_QUESTION_PARTS),
});

export type InterviewOption = z.infer<typeof InterviewOptionSchema>;
export type InterviewQuestionPart = z.infer<typeof InterviewQuestionPartSchema>;
export type InterviewQuestionGroup = z.infer<typeof InterviewQuestionGroupSchema>;

/**
 * What the session wants to know, in groups it says can be asked separately.
 *
 * The session asks for all of it at once — a tool returns to the model rather
 * than waiting on a person, so a question that blocked would deadlock the turn
 * — and what reaches the person one group at a time is the reader's doing. The
 * answers come back as an ordinary turn.
 */
export const InterviewAskedSchema = z.strictObject({
  type: z.literal("asked"),
  groups: z.array(InterviewQuestionGroupSchema).min(1).max(MAX_QUESTION_GROUPS),
});

/** The session is over. */
export const InterviewEndedSchema = z.strictObject({
  type: z.literal("ended"),
  session_id: z.string().min(1),
  reason: z.string().min(1),
});

export const InterviewEventSchema = z.discriminatedUnion("type", [
  InterviewStartedSchema,
  InterviewMessageSchema,
  InterviewRefusedSchema,
  InterviewToolSchema,
  InterviewAskedSchema,
  InterviewEndedSchema,
]);
export type InterviewEvent = z.infer<typeof InterviewEventSchema>;

/** One event as a line of stdout, validated on the way out. */
export function encodeInterviewEvent(event: InterviewEvent): string {
  return `${JSON.stringify(InterviewEventSchema.parse(event))}\n`;
}

/** One turn as a line of stdin, validated on the way in. */
export function encodeInterviewTurn(turn: InterviewTurn): string {
  return `${JSON.stringify(InterviewTurnSchema.parse(turn))}\n`;
}

/**
 * One line of stdin as a turn.
 *
 * Null for a blank line, which is what a host's flush leaves between objects
 * and not something to refuse the session over.
 */
export function decodeInterviewTurn(line: string): InterviewTurn | null {
  if (line.trim().length === 0) return null;
  return InterviewTurnSchema.parse(JSON.parse(line));
}
