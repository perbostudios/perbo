import { setTimeout as delay } from "node:timers/promises";
import {
  egressQuestionLine,
  egressSettledLine,
  refusedHosts,
  type EgressQuestion,
  type PermissionProfile,
} from "@perbo/contracts";
import type { EgressGate, EgressVerdict } from "../../egress.js";
import {
  addToNetworkAllowList,
  closeEgressQuestion,
  egressQuestionKey,
  readEgressQuestions,
  recordEgressQuestion,
} from "../../egress-questions.js";
import { NetworkAllowListSchema } from "../../profile.js";

interface RunEgressQuestionsArgs {
  /** `<state>/<ticket id>.egress.json`. */
  recordPath: string;
  ticketId: string;
  /** What the person types to answer, in the instruction line. */
  ticketKey: string;
  /** The repository's `.perbo/config.json`, where an allowed host is written. */
  configPath: string;
  /** The run's live profile: an allowed host joins its list for the attempts after this one. */
  profile: PermissionProfile;
  progress: (message: string) => void;
  clock: () => Date;
  /** How often the record is read for the answer. */
  pollMs?: number;
}

/**
 * One run's egress questions (D-137).
 *
 * An unlisted host the executor names on a call the runner holds is put to a
 * person, and the attempt waits on the answer rather than stopping. The rules
 * are the run's, so they live here rather than in an attempt:
 *
 * - one question per run, not per host: the first unlisted host asks, and
 *   every later one is refused without asking and recorded, the executor told
 *   the network is closed for the run;
 * - a refusal is remembered on the ticket, so a host a person refused is never
 *   asked about again on it, in this run or a later one;
 * - an allow is that one host: it goes on the repository's
 *   `network_allow_list` and on the live profile, and the held call runs;
 * - the wait is the attempt's stall window: unanswered, the attempt ends
 *   `unlisted_egress_host`, as it does where nothing holds the call.
 *
 * The question travels as data only: the host is the runner's own egress
 * record of what the command named, shown whole with the whole command, and
 * refused unless it is a plain host name. What writes it to the configuration
 * is the person's press, read back from the ticket's record (ADR-0023).
 */
export class RunEgressQuestions {
  private readonly allowed = new Set<string>();
  private readonly refused: Set<string>;
  private asked = false;
  private pending: Promise<EgressVerdict> | null = null;

  private readonly args: RunEgressQuestionsArgs;

  constructor(args: RunEgressQuestionsArgs) {
    this.args = args;
    this.refused = refusedHosts(readEgressQuestions(args.recordPath));
  }

  /** The gate one attempt asks through. */
  forAttempt(attempt_id: string): EgressGate {
    return { ask: (question) => this.ask(attempt_id, question) };
  }

  private async ask(
    attempt_id: string,
    question: Parameters<EgressGate["ask"]>[0],
  ): Promise<EgressVerdict> {
    // One question at a time: a call that names a host while another waits is
    // settled by the rules once that answer is in.
    while (this.pending !== null) await this.pending.catch(() => undefined);
    const host = question.host.toLowerCase();
    if (this.allowed.has(host)) return { answer: "allow" };
    if (!NetworkAllowListSchema.safeParse([host]).success)
      return {
        answer: "refuse",
        tell:
          `${host} is not on this run's network allow-list, and it is not a plain host name a person could ` +
          "allow, so the call is refused. Finish the work without it.",
      };
    if (this.refused.has(host))
      return {
        answer: "refuse",
        tell:
          `A person refused ${host} on this ticket, so the call is refused and it is not asked about again. ` +
          "Finish the work without it.",
      };
    if (this.asked)
      return {
        answer: "refuse",
        tell:
          `${host} is not on this run's network allow-list, and this run has already asked its one question ` +
          "about the network, so the call is refused: the network is closed for the rest of this run beyond " +
          "the allow-list. Finish the work without it.",
      };
    this.asked = true;
    const asking = this.put(attempt_id, host, question);
    this.pending = asking;
    try {
      return await asking;
    } finally {
      this.pending = null;
    }
  }

  /** Record the question, say it, and wait for the answer, the window, or the attempt's stop. */
  private async put(
    attempt_id: string,
    host: string,
    question: Parameters<EgressGate["ask"]>[0],
  ): Promise<EgressVerdict> {
    const { recordPath, ticketId, ticketKey, progress, clock } = this.args;
    const asked = clock();
    const put: EgressQuestion = {
      key: egressQuestionKey(attempt_id, host),
      host,
      command: question.command,
      attempt_id,
      asked_at: asked.toISOString(),
      expires_at: new Date(asked.getTime() + question.wait_ms).toISOString(),
      answer: null,
      closed_at: null,
    };
    recordEgressQuestion(recordPath, ticketId, put);
    progress(egressQuestionLine(put));
    progress(
      `answer with: perbo verdict ${ticketKey} --egress ${put.key} --allow, or --refuse; ` +
        `unanswered by ${put.expires_at}, the attempt stops`,
    );
    const unanswered = (): EgressVerdict => {
      progress(egressSettledLine(put, "unanswered"));
      return {
        answer: "unanswered",
        detail:
          `${host} is not on the resolved allow-list, and nobody answered whether to allow it within ` +
          `${Math.round(question.wait_ms / 60_000)} minute(s)`,
      };
    };
    const settle = (answer: NonNullable<EgressQuestion["answer"]>): EgressVerdict => {
      if (answer.choice === "allow") return this.allow(put);
      this.refused.add(host);
      progress(egressSettledLine(put, "refused"));
      return {
        answer: "refuse",
        tell:
          `A person refused ${host}, so the call is refused. The network is closed for the rest of this run ` +
          "beyond the allow-list: any other host off it is refused too. Finish the work without it.",
      };
    };
    /**
     * The wait is over with nothing read: the question is closed on the
     * record, under its lock, so no answer is taken for it afterwards — and
     * an answer that landed before the close is the one this run acts on.
     */
    const close = (): NonNullable<EgressQuestion["answer"]> | null => {
      try {
        return closeEgressQuestion(recordPath, put.key, clock());
      } catch (error) {
        progress(
          `the egress question ${put.key} could not be closed on ${recordPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    };
    for (;;) {
      if (question.signal.aborted) {
        // The attempt is stopping for another reason: nothing is let through.
        // An answer that landed before the close is still the person's, and
        // is settled as given — an allow on the configuration, a refusal
        // remembered — so the record, the run and what it says agree.
        const landed = close();
        if (landed === null) return unanswered();
        settle(landed);
        return {
          answer: "unanswered",
          detail: `the attempt stopped while ${host} was asked about, so the call it held was not run`,
        };
      }
      const answer = readEgressQuestions(recordPath)?.questions.find((each) => each.key === put.key)?.answer ?? null;
      if (answer !== null) return settle(answer);
      if (clock().getTime() > Date.parse(put.expires_at)) {
        const late = close();
        return late === null ? unanswered() : settle(late);
      }
      try {
        await delay(this.args.pollMs ?? 1_000, undefined, { signal: question.signal });
      } catch {
        // Aborted: read once more at the top, then stop waiting.
      }
    }
  }

  /** The person allowed the host: on the configuration, on the live profile, and let through. */
  private allow(question: EgressQuestion): EgressVerdict {
    const { configPath, profile, progress } = this.args;
    this.allowed.add(question.host);
    try {
      addToNetworkAllowList(configPath, question.host);
    } catch (error) {
      progress(
        `${question.host} was allowed for this run but not written to ${configPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!profile.network_allow_list.includes(question.host)) profile.network_allow_list.push(question.host);
    progress(egressSettledLine(question, "allowed"));
    return { answer: "allow" };
  }
}
