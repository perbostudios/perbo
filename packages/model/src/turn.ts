import type { ModelUsage, UnreportedCostBasis } from "./usage.js";

/**
 * One turn of the read-or-submit protocol, and the port that carries it.
 *
 * A caller hands the model a system prompt, the conversation so far and a
 * schema for what it may submit; the model answers with tool calls, or with
 * nothing. The port exists because the reviewer and the drafter both have to
 * run with no network and no credential in a test, and because three
 * transports reach the same protocol over different wires.
 */

/** The wire names of the two tools. They are bytes a provider receives. */
export const SUBMIT_REVIEW_TOOL = "submit_review";
export const READ_FILE_TOOL = "read_file";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  /** Force `submit_review` on the final turn rather than accepting a stop. */
  forceSubmit: boolean;
}

export interface ModelTurn {
  /** Tool calls the model made this turn. Empty means it stopped without one. */
  toolCalls: ToolCall[];
  usage: ModelUsage;
  stop_reason: string | null;
  /**
   * What the transport says the turn cost, where it knows. Preferred over
   * recomputing from tokens at list prices, because a transport can carry
   * overhead the token counts do not describe.
   */
  reported_cost_micros?: number;
}

export interface Model {
  readonly provider: string;
  readonly model_id: string;
  /**
   * How to account for a turn when the transport does not report dollars.
   * Omission preserves the historical Anthropic list-price estimate.
   */
  readonly unreported_cost_basis?: UnreportedCostBasis;
  turn(request: ModelRequest): Promise<ModelTurn>;
  /**
   * Release what the transport holds for this conversation — a session, a
   * process, a directory. Called once when it ends, however it ended; a
   * transport that holds nothing omits it.
   */
  dispose?(): Promise<void>;
}
