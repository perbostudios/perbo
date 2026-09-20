import type { Model, ModelRequest, ModelTurn, ToolCall } from "./turn.js";
import {
  ZERO_USAGE,
  addUsage,
  resolveModelCost,
  type ModelCostBasis,
  type ModelUsage,
} from "./usage.js";

/**
 * One conversation with a model, and what it cost.
 *
 * The read-or-submit protocol has two halves. This is the half every caller
 * shares: the shape of the messages a turn's tool calls and their answers take
 * on the wire, the system prompt that goes on every turn because a resumed
 * session does not carry one, the tokens and the dollars. The other half —
 * what a read renders to, when to force a submission, whether an answer is
 * acceptable — is policy, and stays with the caller that has it.
 */

/** One tool call, with what the caller answered it. */
export interface ToolResult {
  call: ToolCall;
  content: string;
  /** A call the caller refused. `false` writes no flag at all. */
  isError: boolean;
}

export interface SessionAccounting {
  usage: ModelUsage;
  turns: number;
  cost_micros: number;
  cost_basis: ModelCostBasis;
}

export interface Session {
  /** One turn. Its tokens, and any dollars it reported, are counted. */
  next(forceSubmit: boolean): Promise<ModelTurn>;
  /** The turn's calls as the assistant's message, their results as the user's. */
  answer(results: readonly ToolResult[]): void;
  /** The model stopped without a call: its silence, then the ask. */
  nudge(silence: string, ask: string): void;
  accounting(): SessionAccounting;
  /** Releases what the transport holds. Idempotent. */
  close(): Promise<void>;
}

export function openSession(model: Model, system: string, opening: string): Session {
  const messages: ModelRequest["messages"] = [{ role: "user", content: opening }];
  let usage: ModelUsage = ZERO_USAGE;
  let turns = 0;
  let reportedTurns = 0;
  let reportedCostMicros = 0;
  let closed = false;

  return {
    async next(forceSubmit: boolean): Promise<ModelTurn> {
      const turn = await model.turn({ system, messages, forceSubmit });
      turns += 1;
      usage = addUsage(usage, turn.usage);
      if (turn.reported_cost_micros !== undefined) {
        reportedTurns += 1;
        reportedCostMicros += turn.reported_cost_micros;
      }
      return turn;
    },

    answer(results: readonly ToolResult[]): void {
      messages.push({
        role: "assistant",
        content: results.map((result) => ({
          type: "tool_use",
          id: result.call.id,
          name: result.call.name,
          input: result.call.input,
        })),
      });
      messages.push({
        role: "user",
        content: results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.call.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      });
    },

    nudge(silence: string, ask: string): void {
      messages.push({ role: "assistant", content: [{ type: "text", text: silence }] });
      messages.push({ role: "user", content: ask });
    },

    accounting(): SessionAccounting {
      return {
        usage,
        turns,
        ...resolveModelCost({
          usage,
          turns,
          reportedTurns,
          reportedCostMicros,
          unreportedCostBasis: model.unreported_cost_basis,
        }),
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await model.dispose?.();
    },
  };
}
