import {
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";

/**
 * A scripted drafter. Everything the planning package promises is a property
 * of what happens around the model call — how the issue is delimited, what is
 * accepted back — so the call itself is a double.
 */
export function scriptedDrafter(
  script: Array<Array<{ tool: string; input: unknown }>>,
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
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}

export const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];

export const validDraft = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues exactly one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
    },
    {
      text: "No email is sent for a duplicate signup within 5 minutes.",
      assertion: "a second signup inside the window queues nothing",
      kind: "test",
    },
  ],
  proposed_scope: {
    paths_allowed: ["packages/auth/**", "packages/queue/**"],
    paths_prohibited_extra: [],
  },
  rationale: "The issue describes a missing email; auth owns signup and queue owns delivery.",
  depends_on: [],
  nodes: [],
  edges: [],
};

/**
 * A draft from a spec: criteria citing the requirements they came from, grouped
 * into nodes with an order suggested between them. What `--from-spec` produces,
 * without a model.
 */
export const graphedDraft = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues exactly one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
      requirement_id: "R1",
    },
    {
      text: "No email is sent for a duplicate signup within 5 minutes.",
      assertion: "a second signup inside the window queues nothing",
      kind: "test",
      requirement_id: "R2",
    },
    {
      text: "A failed send is retried three times.",
      assertion: "three attempts are recorded for one failing send",
      kind: "test",
      requirement_id: "R4",
    },
  ],
  proposed_scope: {
    paths_allowed: ["packages/auth/**", "packages/queue/**"],
    paths_prohibited_extra: [],
  },
  rationale: "The spec's three requirements fall into queueing and retrying.",
  depends_on: [],
  nodes: [
    { title: "Queue the email", criteria: [0, 1], paths: ["packages/queue/**"] },
    { title: "Retry a failed send", criteria: [2], paths: ["packages/queue/**"] },
  ],
  edges: [{ from: 0, to: 1 }],
};

/**
 * A drafter that records whether the caller released it. The CLI transport
 * writes a session to the user's store and removes it in `dispose`, so a
 * drafting path that never calls it leaves one behind per admission.
 */
export function disposingDrafter(options: { throws?: boolean } = {}): Model & {
  disposed: () => number;
} {
  let disposed = 0;
  return {
    provider: "double",
    model_id: "scripted",
    disposed: () => disposed,
    async turn(): Promise<ModelTurn> {
      if (options.throws) throw new Error("the transport failed mid-draft");
      return {
        toolCalls: [{ id: "tool_1", name: SUBMIT_REVIEW_TOOL, input: validDraft }],
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "tool_use",
      };
    },
    async dispose(): Promise<void> {
      disposed += 1;
    },
  };
}
