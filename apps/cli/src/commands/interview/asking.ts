import { z } from "zod";
import {
  groupAnswers,
  InterviewQuestionGroupSchema,
  InterviewQuestionPartSchema,
  sameQuestion,
  type InterviewQuestionGroup,
  type InterviewQuestionPart,
  type InterviewTurn,
} from "@perbo/contracts";

/**
 * What a session has put to the person and is still waiting on, in the order
 * it put it, and what they answered: the whole of an {@link AskingRecord}, as
 * the session's record beside its spec keeps it.
 */
export const AskingStateSchema = z.strictObject({
  waiting: z.array(InterviewQuestionGroupSchema),
  answered: z.array(z.strictObject({ part: InterviewQuestionPartSchema, answer: z.string() })),
});
export type AskingState = z.infer<typeof AskingStateSchema>;

/** A session that has asked nothing. */
export const NOTHING_ASKED: AskingState = { waiting: [], answered: [] };

/**
 * What this session has put to the person, and what they answered, read off
 * their turns the way the desktop reads them (D-117).
 *
 * The groups a call put wait in the order it put them, and the person is put
 * the first of them: a turn that is its answer ({@link groupAnswers}, read
 * against the groups behind it) records what each part was answered and moves
 * on to the next, and any other turn of the person's ends every group still
 * waiting, because they have said something of their own and the session is
 * free to ask again once it has answered that. A turn the host marks says what
 * it did itself: one that is not the person's word on these questions — the
 * host's own sentence, or the answer to a question of the host's — leaves them
 * waiting, and the person's own words past a question of the host's end them.
 *
 * It exists so that a question is put once. `ask_options` returns at once and
 * the answers arrive as later turns, so a session that loses its place asks
 * again: twice in one breath, or again after the person has answered. Either
 * way the person is shown a question they are already on or have already
 * answered, and answering it a second time is how their answers come to
 * disagree. So a call that repeats one ({@link sameQuestion}) is refused
 * whole, with what was answered, and asks nothing; so is a call that puts one
 * question twice itself, which the person would be asked twice as well.
 *
 * It starts from what the session's record holds and hands every change to
 * `changed`, which keeps it there, so a session resumed in a new process
 * refuses what it asked in the one before.
 */
export interface AskingRecord {
  /** The groups a call put, waiting behind any already waiting. */
  asked(groups: readonly InterviewQuestionGroup[]): void;
  /** One turn, as it came down stdin. */
  heard(turn: InterviewTurn): void;
  /**
   * Why a call putting these groups is refused, as one sentence the session
   * reads, or null where it asks nothing already asked.
   */
  repeats(groups: readonly InterviewQuestionGroup[]): string | null;
  /** What it holds now. */
  state(): AskingState;
}

export function askingRecord(
  from: AskingState,
  changed: (state: AskingState) => void,
): AskingRecord {
  const waiting: InterviewQuestionGroup[] = structuredClone(from.waiting);
  const answered: { part: InterviewQuestionPart; answer: string }[] = structuredClone(from.answered);
  const state = (): AskingState => structuredClone({ waiting, answered });
  return {
    asked(groups) {
      waiting.push(...structuredClone(groups));
      changed(state());
    },
    heard(turn) {
      if (turn.asking === "kept" || waiting.length === 0) return;
      const first = waiting[0]!;
      const answers = turn.asking === "ended" ? null : groupAnswers(first, turn.text, waiting.slice(1));
      if (answers === null) waiting.length = 0;
      else {
        first.parts.forEach((part, index) => answered.push({ part, answer: answers[index]! }));
        waiting.shift();
      }
      changed(state());
    },
    repeats(groups) {
      const parts = groups.flatMap((group) => group.parts);
      const open: InterviewQuestionPart[] = [];
      const given: { part: InterviewQuestionPart; answer: string }[] = [];
      /** Questions this call puts more than once, and nobody has been asked yet. */
      const twice: InterviewQuestionPart[] = [];
      /** Whether the call puts any question nobody has been asked. */
      let fresh = false;
      parts.forEach((part, at) => {
        const earlier = parts.slice(0, at).some((each) => sameQuestion(each, part));
        if (waiting.some((group) => group.parts.some((each) => sameQuestion(each, part)))) {
          if (!earlier) open.push(part);
          return;
        }
        const was = answered.findLast((each) => sameQuestion(each.part, part));
        if (was !== undefined) {
          if (!earlier) given.push({ part, answer: was.answer });
          return;
        }
        fresh = true;
        if (earlier && !twice.some((each) => sameQuestion(each, part))) twice.push(part);
      });
      if (open.length === 0 && given.length === 0 && twice.length === 0) return null;
      // A part is named by its question, and by its answers as well where
      // another part in sight is worded alike and offers others, since the
      // wording alone would name both.
      const inSight = [...parts, ...waiting.flatMap((group) => group.parts), ...answered.map((each) => each.part)];
      const named = (part: InterviewQuestionPart): string =>
        inSight.some((each) => each.question.trim() === part.question.trim() && !sameQuestion(each, part))
          ? `${quoted(part.question)} (offering ${listed(part.options.map((option) => quoted(option.label)), "or")})`
          : quoted(part.question);
      const doubled = twice.map(named);
      if (open.length === 0 && given.length === 0)
        return (
          `Nothing was put to the person, since ${listed(doubled)} ` +
          `${twice.length === 1 ? "is" : "are"} put more than once in this call; ask again with each question once.`
        );
      const why = [
        ...(twice.length === 0
          ? []
          : [`${listed(doubled)} ${twice.length === 1 ? "is" : "are"} put more than once in this call`]),
        ...(open.length === 0
          ? []
          : [`${listed(open.map(named))} ${open.length === 1 ? "is" : "are"} already asked and waiting on their answer`]),
        ...given.map((each) => `${named(each.part)} was already answered ${quoted(each.answer)}`),
      ];
      const next =
        open.length === 0
          ? given.length === 1
            ? "take that answer from the conversation"
            : "take those answers from the conversation"
          : given.length === 0
            ? `wait for ${open.length === 1 ? "the answer to come as their next turn" : "the answers to come as their next turns"}`
            : "wait for the answers still to come as their next turns, and take the ones given from the conversation";
      const rest = fresh
        ? `, and put only the new questions${twice.length === 0 ? "" : ", each once,"} in a call of their own`
        : "";
      return `Nothing was put to the person, since ${listed(why)}; ${next} rather than asking again${rest}.`;
    },
    state,
  };
}

const quoted = (text: string): string => `"${text}"`;

/** Items in a run of prose: "a", "a and b", "a, b and c", or with "or". */
function listed(items: readonly string[], last: "and" | "or" = "and"): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)!}`;
}
