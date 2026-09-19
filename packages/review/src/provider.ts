import Anthropic from "@anthropic-ai/sdk";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL } from "./verdict.js";

/**
 * The model call.
 *
 * One provider, one interface, one implementation, plus a double so the tests
 * run with no network and no credential. The interface exists because those
 * tests have to exist — not because a second provider is planned.
 */

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
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

export interface ModelRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  /** Force `submit_review` on the final turn rather than accepting a stop. */
  forceSubmit: boolean;
}

export type ModelCostBasis =
  | "transport_reported"
  | "provider_list_estimate"
  | "unavailable";

export interface ReviewModel {
  readonly provider: string;
  readonly model_id: string;
  /**
   * How to account for a turn when the transport does not report dollars.
   * Omission preserves the historical Anthropic list-price estimate.
   */
  readonly unreported_cost_basis?: Exclude<ModelCostBasis, "transport_reported">;
  turn(request: ModelRequest): Promise<ModelTurn>;
  /**
   * Release what the transport holds for this review — a session, a process, a
   * directory. Called once when the review ends, however it ended; a transport
   * that holds nothing omits it.
   */
  dispose?(): Promise<void>;
}

export const MODEL_ID = "claude-opus-5";

/**
 * Claude API list prices, in micro-dollars per token. $5 / $25 per million for
 * Claude Opus 5; cache reads are a tenth of the input rate and cache writes a
 * quarter more. Recorded per review because D-010 has a cost threshold and a
 * cost nobody measured is not a number.
 */
export const PRICE_MICROS_PER_TOKEN = {
  input: 5,
  output: 25,
  cache_read: 0.5,
  cache_creation: 6.25,
} as const;

export function costMicros(usage: ModelUsage): number {
  return Math.round(
    usage.input_tokens * PRICE_MICROS_PER_TOKEN.input +
      usage.output_tokens * PRICE_MICROS_PER_TOKEN.output +
      usage.cache_read_input_tokens * PRICE_MICROS_PER_TOKEN.cache_read +
      usage.cache_creation_input_tokens * PRICE_MICROS_PER_TOKEN.cache_creation,
  );
}

export function resolveModelCost(args: {
  usage: ModelUsage;
  turns: number;
  reportedTurns: number;
  reportedCostMicros: number;
  unreportedCostBasis?: ReviewModel["unreported_cost_basis"];
}): { cost_micros: number; cost_basis: ModelCostBasis } {
  if (args.turns > 0 && args.reportedTurns === args.turns) {
    return {
      cost_micros: args.reportedCostMicros,
      cost_basis: "transport_reported",
    };
  }
  if (args.unreportedCostBasis === "unavailable") {
    return { cost_micros: 0, cost_basis: "unavailable" };
  }
  return {
    cost_micros: costMicros(args.usage),
    cost_basis: "provider_list_estimate",
  };
}

export const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

export type ProviderErrorKind = "provider_unavailable" | "budget_exhausted" | "timeout";

/** How much of a transport's own error text a review record may carry. */
const MAX_FAILURE_TEXT = 300;

/**
 * Node names the argument it refused by quoting it — `… must be a string
 * without null bytes. Received '<perbo:repo_file …'`. The sentence before it
 * says what went wrong; the quotation is the value itself, and goes.
 */
const RECEIVED = /\s*Received\b[\s\S]*$/;

/**
 * A transport failure as a review record is allowed to state it.
 *
 * `errors[].message` is written into the run bundle and read by a person, and
 * until SCP-188 it could be the whole prompt: AYO-33's bundle carried the
 * contents of `packages/contracts/src/verdicts.ts`, because the prompt was a
 * command-line argument and Node quoted the argument it refused. Nothing the
 * transport handed the process is quoted back here — the quotation is dropped,
 * what remains is one bounded line, and a line that still opens with text that
 * was sent is withheld entirely.
 *
 * An error *about a file* is not this: the reader's refusals name the path and
 * the reason and never carry the bytes, and they reach the model as a read
 * result rather than as a transport failure.
 *
 * @param raw the transport's own error text
 * @param sent every string this turn handed the process
 */
export function providerFailureText(raw: string, sent: readonly string[]): string {
  const first = (raw.split("\n", 1)[0] ?? "").replace(RECEIVED, "").trim();
  if (first === "") return "no error text";
  const bounded =
    first.length > MAX_FAILURE_TEXT ? `${first.slice(0, MAX_FAILURE_TEXT)}\u2026` : first;
  return quotesSentText(bounded, sent)
    ? "the transport quoted what it was sent, and it was withheld"
    : bounded;
}

function quotesSentText(text: string, sent: readonly string[]): boolean {
  return sent.some((value) => {
    // A control byte is written as an escape wherever it is quoted, so the
    // probe is the printable opening of what was sent rather than all of it.
    const probe = (/^[^\p{Cc}]*/u.exec(value)?.[0] ?? "").slice(0, 40);
    return probe.length >= 12 && text.includes(probe);
  });
}

export class ProviderError extends Error {
  readonly attempts: number;
  readonly kind: ProviderErrorKind;

  constructor(message: string, attempts: number, kind: ProviderErrorKind = "provider_unavailable") {
    super(message);
    this.name = "ProviderError";
    this.attempts = attempts;
    this.kind = kind;
  }
}

export interface AnthropicModelOptions {
  /** JSON Schema for `submit_review`, built from the plan's criteria list. */
  submitSchema: Record<string, unknown>;
  maxTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  modelId?: string;
  /** Injected by tests. Production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const READ_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      description:
        "Repository-relative path, exactly as it appears in the file listing. One file per call.",
    },
  },
} as const;

export function anthropicModel(options: AnthropicModelOptions): ReviewModel {
  const modelId = options.modelId ?? MODEL_ID;
  // The SDK retries inside one call, so the number of requests a turn made is
  // only visible at the transport. Counted there, so an error reports what
  // happened rather than the retry budget.
  const transport = options.fetch ?? globalThis.fetch;
  let requestsThisTurn = 0;
  const counted: typeof globalThis.fetch = (input, init) => {
    requestsThisTurn += 1;
    return transport(input, init);
  };
  // BYOK. The SDK resolves ANTHROPIC_API_KEY from the environment; no key is
  // read from, or written to, anything in the repository.
  const client = new Anthropic({
    maxRetries: options.maxRetries ?? 3,
    timeout: options.timeoutMs ?? 240_000,
    fetch: counted,
  });

  const tools: Anthropic.Tool[] = [
    {
      name: READ_FILE_TOOL,
      description:
        "Read one file from the repository at head. Use it to follow the change out of the diff.",
      input_schema: READ_FILE_SCHEMA as unknown as Anthropic.Tool.InputSchema,
    },
    {
      name: SUBMIT_REVIEW_TOOL,
      description:
        "Submit the review. Call exactly once, with one coverage entry per criterion in the plan.",
      input_schema: options.submitSchema as unknown as Anthropic.Tool.InputSchema,
      strict: true,
    },
  ];

  return {
    provider: "anthropic",
    model_id: modelId,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      requestsThisTurn = 0;
      try {
        const stream = client.messages.stream({
          model: modelId,
          max_tokens: options.maxTokens ?? 16_000,
          thinking: { type: "adaptive" },
          output_config: { effort: options.effort ?? "high" },
          system: [
            {
              type: "text",
              text: request.system,
              // The system prompt and the tool list are byte-identical across
              // the turns of one review, so the prefix caches.
              cache_control: { type: "ephemeral" },
            },
          ],
          tools,
          ...(request.forceSubmit
            ? { tool_choice: { type: "tool" as const, name: SUBMIT_REVIEW_TOOL } }
            : {}),
          messages: request.messages as Anthropic.MessageParam[],
        });
        const message = await stream.finalMessage();

        return {
          toolCalls: message.content
            .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
            .map((block) => ({ id: block.id, name: block.name, input: block.input })),
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
            cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
          },
          stop_reason: message.stop_reason,
        };
      } catch (error) {
        const attempts = Math.max(1, requestsThisTurn);
        if (error instanceof Anthropic.APIError) {
          const kind =
            error.status === 408 || error.status === 504 ? "timeout" : "provider_unavailable";
          throw new ProviderError(
            `${error.name} ${error.status ?? ""}: ${error.message}`.trim(),
            attempts,
            kind,
          );
        }
        throw new ProviderError(
          error instanceof Error ? error.message : String(error),
          attempts,
          "provider_unavailable",
        );
      }
    },
  };
}
