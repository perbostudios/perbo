import { describe, expect, it } from "vitest";
import { openSession } from "./session.js";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL, type Model, type ModelRequest } from "./turn.js";
import { ZERO_USAGE, type ModelUsage } from "./usage.js";

/**
 * The conversation's shape and its accounting, which the reviewer, the drafter
 * and the closure verifier all had their own copy of. What a read renders to
 * and when to force a submission stay the caller's; the message bytes and the
 * cost do not.
 */

function recorder(
  options: {
    usage?: Partial<ModelUsage>;
    reported?: number | undefined;
    unreported?: "provider_list_estimate" | "unavailable";
  } = {},
): Model & { requests: ModelRequest[]; disposed: () => number } {
  const requests: ModelRequest[] = [];
  let disposed = 0;
  return {
    provider: "double",
    model_id: "scripted",
    requests,
    disposed: () => disposed,
    ...(options.unreported ? { unreported_cost_basis: options.unreported } : {}),
    async turn(request) {
      requests.push(structuredClone(request) as ModelRequest);
      return {
        toolCalls: [],
        usage: { ...ZERO_USAGE, input_tokens: 1000, output_tokens: 200, ...options.usage },
        stop_reason: "end_turn",
        ...(options.reported === undefined ? {} : { reported_cost_micros: options.reported }),
      };
    },
    async dispose() {
      disposed += 1;
    },
  };
}

const call = (id: string, name: string, input: unknown) => ({ id, name, input });

describe("a session's messages", () => {
  it("opens with the caller's text and carries the system prompt on every turn", async () => {
    const model = recorder();
    const session = openSession(model, "the system prompt", "the context");
    await session.next(false);
    await session.next(true);

    expect(model.requests.map((request) => request.system)).toEqual([
      "the system prompt",
      "the system prompt",
    ]);
    expect(model.requests.map((request) => request.forceSubmit)).toEqual([false, true]);
    expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "the context" }]);
  });

  it("writes a tool call and its result in the order a provider reads them", async () => {
    const model = recorder();
    const session = openSession(model, "S", "the context");
    await session.next(false);
    session.answer([
      { call: call("t1", READ_FILE_TOOL, { path: "a.ts" }), content: "the file", isError: false },
      { call: call("t2", READ_FILE_TOOL, { path: "b.ts" }), content: "refused", isError: true },
    ]);
    await session.next(false);

    // Key order is part of the bytes a provider receives.
    expect(JSON.stringify(model.requests[1]?.messages.slice(1))).toBe(
      JSON.stringify([
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: READ_FILE_TOOL, input: { path: "a.ts" } },
            { type: "tool_use", id: "t2", name: READ_FILE_TOOL, input: { path: "b.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "the file" },
            { type: "tool_result", tool_use_id: "t2", content: "refused", is_error: true },
          ],
        },
      ]),
    );
  });

  it("omits is_error rather than writing it false", async () => {
    const model = recorder();
    const session = openSession(model, "S", "the context");
    await session.next(false);
    session.answer([
      { call: call("t1", SUBMIT_REVIEW_TOOL, { ok: true }), content: "try again", isError: false },
    ]);
    await session.next(false);

    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain("is_error");
  });

  it("writes the model's silence and the ask that follows it", async () => {
    const model = recorder();
    const session = openSession(model, "S", "the context");
    await session.next(false);
    session.nudge("(no tool call)", "Submit now.");
    await session.next(false);

    expect(model.requests[1]?.messages.slice(1)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "(no tool call)" }] },
      { role: "user", content: "Submit now." },
    ]);
  });
});

describe("a session's accounting", () => {
  it("counts nothing before a turn is taken", () => {
    const session = openSession(recorder(), "S", "the context");
    expect(session.accounting()).toEqual({
      usage: ZERO_USAGE,
      turns: 0,
      cost_micros: 0,
      cost_basis: "provider_list_estimate",
    });
  });

  it("sums the tokens and prices them at list where no turn reported dollars", async () => {
    const session = openSession(recorder(), "S", "the context");
    await session.next(false);
    await session.next(true);
    expect(session.accounting()).toEqual({
      usage: { ...ZERO_USAGE, input_tokens: 2000, output_tokens: 400 },
      turns: 2,
      cost_micros: 20_000,
      cost_basis: "provider_list_estimate",
    });
  });

  it("takes the transport's own figure when every turn reported one", async () => {
    const session = openSession(recorder({ reported: 1_500 }), "S", "the context");
    await session.next(false);
    await session.next(true);
    expect(session.accounting()).toMatchObject({
      turns: 2,
      cost_micros: 3_000,
      cost_basis: "transport_reported",
    });
  });

  it("records no figure for a transport that says the cost is unavailable", async () => {
    const session = openSession(recorder({ unreported: "unavailable" }), "S", "the context");
    await session.next(false);
    expect(session.accounting()).toMatchObject({ cost_micros: 0, cost_basis: "unavailable" });
  });
});

describe("closing a session", () => {
  it("releases the transport once, however often it is closed", async () => {
    const model = recorder();
    const session = openSession(model, "S", "the context");
    await session.next(false);
    await session.close();
    await session.close();
    expect(model.disposed()).toBe(1);
  });

  it("is silent for a transport that holds nothing", async () => {
    const model: Model = {
      provider: "double",
      model_id: "scripted",
      async turn() {
        return { toolCalls: [], usage: ZERO_USAGE, stop_reason: null };
      },
    };
    await expect(openSession(model, "S", "the context").close()).resolves.toBeUndefined();
  });
});
