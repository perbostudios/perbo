import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CLAUDE_MODEL } from "./defaults.js";
import { ProviderError } from "./failure.js";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL, type Model, type ModelRequest, type ModelTurn } from "./turn.js";

/**
 * The model call over the Anthropic SDK: one request per turn, the two tools
 * defined in full, and the system prompt cached because it is byte-identical
 * across the turns of one conversation.
 */

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

export function anthropicModel(options: AnthropicModelOptions): Model {
  const modelId = options.modelId ?? DEFAULT_CLAUDE_MODEL;
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
