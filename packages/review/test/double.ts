import {
  READ_FILE_TOOL,
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";

/**
 * A scripted model. The reviewer's behaviour under a given verdict has to be
 * testable without a network or a credential, and every property the review
 * contract promises is a property of what happens *after* the model speaks.
 */
export function scriptedModel(
  script: Array<{ tool: string; input: unknown }[]>,
  usagePerTurn = { input_tokens: 1000, output_tokens: 200 },
): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    requests,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      requests.push(request);
      const calls = script[turn] ?? [];
      turn += 1;
      return {
        toolCalls: calls.map((call, index) => ({
          id: `tool_${turn}_${index}`,
          name: call.tool,
          input: call.input,
        })),
        usage: {
          input_tokens: usagePerTurn.input_tokens,
          output_tokens: usagePerTurn.output_tokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}

export const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];
export const reads = (...paths: string[]) =>
  paths.map((path) => ({ tool: READ_FILE_TOOL, input: { path } }));

export function coverageEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    criterion_id: "ac_1",
    status: "met",
    verification_strength: "directly_verified",
    evidence_type: "test_result",
    evidence_ref: "check_ut",
    evidence_assertion: "expect(result.ok).toBe(true)",
    evidence_file: "packages/a/test/a.test.ts",
    evidence_line: 5,
    evidence_symbol: null,
    note: null,
    ...overrides,
  };
}
