import {
  groupAnswers,
  sameQuestion,
  type InterviewQuestionGroup,
  type InterviewQuestionPart,
} from "@perbo/contracts";

/**
 * What this session has put to the person, and what they answered, read off
 * their turns the way the desktop reads them (D-117).
 *
 * The groups a call put wait in the order it put them, and the person is put
 * the first of them: a turn that is its answer ({@link groupAnswers}) records
 * what each part was answered and moves on to the next, and any other turn
 * ends every group still waiting, because the person has said something of
 * their own and the session is free to ask again once it has answered that.
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
 * Held for the life of the process. A session resumed in a new one starts with
 * nothing asked, and the desktop's own record of the asking still puts no
 * second card for a question it has shown.
 */
export interface AskingRecord {
  /** The groups a call put, waiting behind any already waiting. */
  asked(groups: readonly InterviewQuestionGroup[]): void;
  /** One of the person's turns. */
  heard(text: string): void;
  /**
   * Why a call putting these groups is refused, as one sentence the session
   * reads, or null where it asks nothing already asked.
   */
  repeats(groups: readonly InterviewQuestionGroup[]): string | null;
}

export function askingRecord(): AskingRecord {
  const waiting: InterviewQuestionGroup[] = [];
  const answered: { part: InterviewQuestionPart; answer: string }[] = [];
  return {
    asked(groups) {
      waiting.push(...groups);
    },
    heard(text) {
      const first = waiting[0];
      if (first === undefined) return;
      const answers = groupAnswers(first, text);
      if (answers === null) {
        waiting.length = 0;
        return;
      }
      first.parts.forEach((part, index) => answered.push({ part, answer: answers[index]! }));
      waiting.shift();
    },
    repeats(groups) {
      const parts = groups.flatMap((group) => group.parts);
      const open: string[] = [];
      const given: { question: string; answer: string }[] = [];
      /** Questions this call puts more than once, and nobody has been asked yet. */
      const twice: string[] = [];
      /** Whether the call puts any question nobody has been asked. */
      let fresh = false;
      parts.forEach((part, at) => {
        const earlier = parts.slice(0, at).some((each) => sameQuestion(each, part));
        if (waiting.some((group) => group.parts.some((each) => sameQuestion(each, part)))) {
          if (!earlier) open.push(part.question);
          return;
        }
        const was = answered.findLast((each) => sameQuestion(each.part, part));
        if (was !== undefined) {
          if (!earlier) given.push({ question: part.question, answer: was.answer });
          return;
        }
        fresh = true;
        if (earlier && !twice.includes(part.question)) twice.push(part.question);
      });
      if (open.length === 0 && given.length === 0 && twice.length === 0) return null;
      if (open.length === 0 && given.length === 0)
        return (
          `Nothing was put to the person, since ${listed(twice.map(quoted))} ` +
          `${twice.length === 1 ? "is" : "are"} put more than once in this call; ask again with each question once.`
        );
      const why = [
        ...(twice.length === 0
          ? []
          : [`${listed(twice.map(quoted))} ${twice.length === 1 ? "is" : "are"} put more than once in this call`]),
        ...(open.length === 0
          ? []
          : [`${listed(open.map(quoted))} ${open.length === 1 ? "is" : "are"} already asked and waiting on their answer`]),
        ...given.map((each) => `${quoted(each.question)} was already answered ${quoted(each.answer)}`),
      ];
      const next =
        open.length === 0
          ? given.length === 1
            ? "take that answer from the conversation"
            : "take those answers from the conversation"
          : given.length === 0
            ? `wait for ${open.length === 1 ? "the answer to come as their next turn" : "the answers to come as their next turns"}`
            : "wait for the answers still to come as their next turns, and take the ones given from the conversation,";
      const rest = fresh
        ? `, and put only the new questions${twice.length === 0 ? "" : ", each once,"} in a call of their own`
        : "";
      return `Nothing was put to the person, since ${listed(why)}; ${next} rather than asking again${rest}.`;
    },
  };
}

const quoted = (text: string): string => `"${text}"`;

/** Items in a run of prose: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}
