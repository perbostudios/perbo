import { z } from "zod";
import { AttemptIdSchema, TicketIdSchema } from "./ids.js";
import { escaped, unescaped } from "./spoken.js";

/**
 * An unlisted host the executor named, put to a person as a question while
 * the attempt waits (D-137).
 *
 * Three readers agree on it: the runner, which asks and waits; `perbo verdict
 * --egress`, which records the answer; and the desktop, which shows the
 * question from the run's own output and sends the press. Here, and
 * browser-safe, for that reason.
 */

/** What a person answers: the one host, allowed or refused. */
export const EGRESS_ANSWERS = ["allow", "refuse"] as const;
export const EgressAnswerSchema = z.enum(EGRESS_ANSWERS);
export type EgressAnswer = (typeof EGRESS_ANSWERS)[number];

/** A question's key: `egq_` and sixteen hex digits, minted from the attempt and the host. */
export const EgressQuestionKeySchema = z.string().regex(/^egq_[0-9a-f]{16}$/, "an egress question key looks like egq_<16 hex>");

export const EgressQuestionSchema = z.strictObject({
  key: EgressQuestionKeySchema,
  /** The host the command named, as the runner's egress log read it. */
  host: z.string().min(1),
  /** The whole command that named it, redacted as the attempt's record is. */
  command: z.string(),
  /** The attempt that is waiting on the answer. */
  attempt_id: AttemptIdSchema,
  asked_at: z.iso.datetime(),
  /**
   * When the attempt stops waiting: the attempt's stall window after it
   * asked. An answer after it answers nothing; the attempt has stopped as
   * `unlisted_egress_host`.
   */
  expires_at: z.iso.datetime(),
  /** The person's answer, or null while nobody has given one. */
  answer: z
    .strictObject({
      choice: EgressAnswerSchema,
      /** Who answered, as the verdicts record names a person. */
      author: z.string().min(1),
      decided_at: z.iso.datetime(),
    })
    .nullable(),
  /**
   * When the run stopped waiting with no answer — the window passed, or the
   * attempt stopped for another reason — and null while it waits or once it
   * was answered. A closed question takes no answer: nothing would act on it.
   */
  closed_at: z.iso.datetime().nullable(),
});
export type EgressQuestion = z.infer<typeof EgressQuestionSchema>;

export const EGRESS_QUESTIONS_SCHEMA_VERSION = 1;

/** One ticket's egress questions, every run of it, oldest first. */
export const EgressQuestionsSchema = z.strictObject({
  schema_version: z.literal(EGRESS_QUESTIONS_SCHEMA_VERSION),
  ticket_id: TicketIdSchema,
  questions: z.array(EgressQuestionSchema),
});
export type EgressQuestions = z.infer<typeof EgressQuestionsSchema>;

/** The hosts a person refused on this ticket, which are never asked about again on it. */
export function refusedHosts(record: Pick<EgressQuestions, "questions"> | null): Set<string> {
  return new Set(
    (record?.questions ?? []).filter((question) => question.answer?.choice === "refuse").map((question) => question.host),
  );
}

/** Whether the question still takes an answer at `now`: unanswered, not closed, and before it expired. */
export function egressQuestionOpen(
  question: Pick<EgressQuestion, "answer" | "expires_at" | "closed_at">,
  now: Date,
): boolean {
  return question.answer === null && question.closed_at === null && now.getTime() <= Date.parse(question.expires_at);
}

/**
 * The progress lines the run prints for a question: one as it asks, and one
 * as it is settled. The command is escaped onto the one physical line, so no
 * part of it can pass for a line of the runner's own (ADR-0023), and it is
 * restored exactly where it is read back to be shown.
 */
const QUESTION = /^waiting on you: allow (\S+)\? \((egq_[0-9a-f]{16})\) (.*)$/;
const SETTLED = /^egress (egq_[0-9a-f]{16}) (\S+): (allowed|refused|unanswered)$/;

export type EgressSettlement = "allowed" | "refused" | "unanswered";

export function egressQuestionLine(question: Pick<EgressQuestion, "key" | "host" | "command">): string {
  return `waiting on you: allow ${question.host}? (${question.key}) ${escaped(question.command)}`;
}

export function readEgressQuestion(line: string): Pick<EgressQuestion, "key" | "host" | "command"> | null {
  const match = QUESTION.exec(line);
  return match === null ? null : { host: match[1]!, key: match[2]!, command: unescaped(match[3]!) };
}

export function egressSettledLine(question: Pick<EgressQuestion, "key" | "host">, settled: EgressSettlement): string {
  return `egress ${question.key} ${question.host}: ${settled}`;
}

export function readEgressSettled(
  line: string,
): { key: string; host: string; settled: EgressSettlement } | null {
  const match = SETTLED.exec(line);
  return match === null ? null : { key: match[1]!, host: match[2]!, settled: match[3] as EgressSettlement };
}
