import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  EGRESS_QUESTIONS_SCHEMA_VERSION,
  EgressQuestionsSchema,
  egressQuestionOpen,
  type EgressAnswer,
  type EgressQuestion,
  type EgressQuestions,
} from "@perbo/contracts";
import { replaceFile } from "@perbo/workspace";
import { NetworkAllowListSchema } from "./profile.js";
import { withRecordLock } from "./record-lock.js";

/**
 * One ticket's egress questions on disk, `<store>/state/<ticket id>.egress.json`
 * (D-NEW-an-unlisted-host-asks).
 *
 * More than one process changes it: the run appends a question and closes one
 * it stopped waiting on, and `perbo verdict --egress` writes the answer — from
 * a terminal and from the desktop's press, which can race. So every change is
 * made under the record's lock and starts from the record read again under
 * it: two answers to one question cannot both be taken, an answer and a close
 * cannot both land, and a run's append is never written over. The file is
 * replaced whole, so a reader that takes no lock never sees half of one.
 */

/** The record is there and cannot be read, so nothing may be written over it. */
export class EgressQuestionsError extends Error {}

/** The ticket's record, or null where no run of it has asked anything. */
export function readEgressQuestions(path: string): EgressQuestions | null {
  if (!existsSync(path)) return null;
  try {
    return EgressQuestionsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new EgressQuestionsError(
      `${path} is not a readable egress questions record: ` +
        `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

export function writeEgressQuestions(path: string, record: EgressQuestions): void {
  mkdirSync(dirname(path), { recursive: true });
  replaceFile(path, `${JSON.stringify(EgressQuestionsSchema.parse(record), null, 2)}\n`);
}

/** A question's key, from the attempt that asked it and the host: one question per host per attempt. */
export function egressQuestionKey(attempt_id: string, host: string): string {
  return `egq_${createHash("sha256").update(`${attempt_id}|${host}`).digest("hex").slice(0, 16)}`;
}

/** Append one question to the ticket's record. */
export function recordEgressQuestion(path: string, ticket_id: string, question: EgressQuestion): void {
  withRecordLock(path, new Date(question.asked_at), () => {
    const record = readEgressQuestions(path) ?? {
      schema_version: EGRESS_QUESTIONS_SCHEMA_VERSION,
      ticket_id,
      questions: [],
    };
    writeEgressQuestions(path, { ...record, questions: [...record.questions, question] });
  });
}

/**
 * The run stops waiting on a question: its window passed, or the attempt
 * stopped for another reason. Under the lock, the question is closed where
 * nobody answered it, so no later answer is taken for a wait that is over; an
 * answer written before the close is returned instead, since the person gave
 * it while the run still waited.
 */
export function closeEgressQuestion(path: string, key: string, now: Date): EgressQuestion["answer"] {
  return withRecordLock(path, now, () => {
    const record = readEgressQuestions(path);
    const question = record?.questions.find((each) => each.key === key);
    if (record === null || question === undefined) return null;
    if (question.answer !== null) return question.answer;
    if (question.closed_at !== null) return null;
    writeEgressQuestions(path, {
      ...record,
      questions: record.questions.map((each) => (each.key === key ? { ...each, closed_at: now.toISOString() } : each)),
    });
    return null;
  });
}

/** A question an answer cannot be given to, and why. */
export class EgressAnswerRefusedError extends Error {}

/**
 * Record a person's answer to one open question, found by its key or by a
 * prefix that names one question. Refused, and nothing written, where the key
 * names none, where the question is answered already, where the run closed it
 * or its window passed, or where no live run of the ticket is the one that
 * asked: a run started after the question was asked is a later run, and an
 * answer for the one that asked would be read by nothing. Read and written
 * under the record's lock, so the answer and a close cannot both land.
 */
export function answerEgressQuestion(args: {
  path: string;
  key: string;
  choice: EgressAnswer;
  author: string;
  now: Date;
  /** When each live run of the ticket started, from its run lock. */
  liveRuns: readonly { started_at: string }[];
  /** How long to wait for the record's lock; the lock's own bound unless a test shortens it. */
  lockWaitMs?: number;
}): EgressQuestion {
  return withRecordLock(args.path, args.now, () => answerUnderLock(args), args.lockWaitMs);
}

function answerUnderLock(args: Parameters<typeof answerEgressQuestion>[0]): EgressQuestion {
  const record = readEgressQuestions(args.path);
  const wanted = args.key.trim().toLowerCase();
  const matches = (record?.questions ?? []).filter((question) => question.key.startsWith(wanted));
  if (matches.length === 0)
    throw new EgressAnswerRefusedError(
      record === null || record.questions.length === 0
        ? `no run of this ticket has asked about a host, so '${args.key}' is not a question`
        : `'${args.key}' is not a question on this ticket. Its questions: ${record.questions
            .map((question) => `${question.key} ${question.host}`)
            .join(", ")}`,
    );
  if (matches.length > 1)
    throw new EgressAnswerRefusedError(
      `'${args.key}' names ${matches.length} questions (${matches.map((question) => question.key).join(", ")}); give more of the key`,
    );
  const question = matches[0]!;
  if (question.answer !== null)
    throw new EgressAnswerRefusedError(
      `${question.key} (${question.host}) was answered ${question.answer.choice} by ${question.answer.author} at ` +
        `${question.answer.decided_at}`,
    );
  if (question.closed_at !== null)
    throw new EgressAnswerRefusedError(
      `${question.key} (${question.host}) was closed at ${question.closed_at}: the run stopped waiting on it, so ` +
        "nothing would act on an answer",
    );
  if (!egressQuestionOpen(question, args.now))
    throw new EgressAnswerRefusedError(
      `${question.key} (${question.host}) expired at ${question.expires_at}: nobody answered within the attempt's ` +
        "stall window, so the attempt stopped as unlisted_egress_host and nothing waits on an answer",
    );
  if (!args.liveRuns.some((run) => Date.parse(run.started_at) <= Date.parse(question.asked_at)))
    throw new EgressAnswerRefusedError(
      `no live run of this ticket is the one that asked ${question.key} (${question.host}), so nothing is waiting ` +
        "on an answer; a run asks again where it needs one",
    );
  const answered: EgressQuestion = {
    ...question,
    answer: { choice: args.choice, author: args.author, decided_at: args.now.toISOString() },
  };
  writeEgressQuestions(args.path, {
    ...record!,
    questions: record!.questions.map((each) => (each.key === question.key ? answered : each)),
  });
  return answered;
}

/**
 * Add one host to a repository's `network_allow_list` in `.perbo/config.json`
 * (D-NEW-an-unlisted-host-asks, D-035): the person's allow, written by the
 * runner. The host is refused unless it is a plain host name, by the same
 * schema a run reads the list with (ADR-0023), and the rest of the file —
 * every other key, `_comment` keys included, in its order — is kept. The file
 * is replaced whole. Returns whether the list changed.
 */
export function addToNetworkAllowList(configPath: string, host: string): boolean {
  const [checked] = NetworkAllowListSchema.parse([host]);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${configPath} is not a JSON object, so the host was not added to it`);
    config = parsed as Record<string, unknown>;
  }
  const listed = config["network_allow_list"] === undefined ? [] : NetworkAllowListSchema.parse(config["network_allow_list"]);
  if (listed.some((entry) => entry.toLowerCase() === checked!.toLowerCase())) return false;
  config = { ...config, network_allow_list: [...listed, checked!] };
  mkdirSync(dirname(configPath), { recursive: true });
  replaceFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}
