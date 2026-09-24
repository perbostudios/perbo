import { describe, expect, it } from "vitest";
import { claudeInterviewTransport, type InterviewSdk, type InterviewUserMessage } from "./claude.js";
import type { InterviewSession } from "./index.js";

/**
 * How many of the person's turns each ending of the Claude session answered.
 *
 * Claude Code folds a turn sent while one is running into it, and the one
 * `result` answers both; a turn sent after the running one has said its last
 * word gets a `result` of its own. The `result` lists the user messages its
 * turn consumed, by the ids the transport gave them; one with no list answers
 * every turn handed to the SDK since the last.
 */
describe("the Claude session's ending of a turn", () => {
  it("answers the person's turns a list names, and every turn handed where there is no list", async () => {
    const sdk: InterviewSdk = {
      tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
      createSdkMcpServer: () => ({}),
      async *query({ prompt }) {
        const turns = prompt[Symbol.asyncIterator]();
        const next = async (): Promise<InterviewUserMessage> =>
          (await turns.next()).value as InterviewUserMessage;
        // The second turn arrives mid-way and is folded into the first, and
        // the result that ends them lists nothing.
        await next();
        await next();
        yield { type: "result" };
        // The third arrives once that ending is written: its own result.
        const third = await next();
        yield { type: "result", user_message_uuids: [third.uuid, "not-the-person's"] };
        // A list naming none of the person's turns answers none of them.
        await next();
        yield { type: "result", user_message_uuids: ["not-the-person's"] };
        yield { type: "result" };
      },
    };
    const session = {
      cwd: "/",
      model: null,
      resume: null,
      orientation: "",
      tools: [],
      decide: () => Promise.resolve({ behavior: "allow", updatedInput: {} }),
      turns: (async function* () {
        yield* ["one", "two", "three", "four"];
      })(),
      sessionId: () => "",
      stderr: () => undefined,
    } as unknown as InterviewSession;
    const idle: number[] = [];
    for await (const streamed of claudeInterviewTransport(sdk, "claude").run(session))
      if (streamed.idle !== undefined) idle.push(streamed.idle);
    expect(idle).toEqual([2, 1, 0, 1]);
  });
});
