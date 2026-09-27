import { describe, expect, it } from "vitest";
import {
  describeTransportFailure,
  isRetryableStatus,
  resetInText,
  transportExhaustion,
} from "./transport.js";

/**
 * Reading a transport failure out of a transcript (SCP-172).
 *
 * The shapes here are the ones a real agent writes: the retry notices and the
 * synthetic assistant message measured on this repository's own 529, the result
 * envelope's `api_error_status`, and the connection-level failure that never
 * gets a status at all. The interesting cases are the ones that must **not**
 * match — a refusal the transport would never retry, and the text of a 529
 * sitting in a file the agent happened to read.
 */

const OVERLOADED = JSON.stringify({
  type: "error",
  error: { type: "overloaded_error", message: "Overloaded" },
});

describe("what the transport would have retried", () => {
  it("follows the SDK's rule rather than a list of its own", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("reading the failure out of a transcript", () => {
  it("reads the synthetic assistant message an exhausted 529 leaves behind", () => {
    const failure = transportExhaustion([
      '{"type":"system","subtype":"init"}',
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `API Error: 529 ${OVERLOADED}` }] },
      }),
    ]);
    expect(failure?.status).toBe(529);
    expect(failure?.error_type).toBe("overloaded_error");
    expect(failure?.message).toBe("Overloaded");
  });

  it("counts the retries the agent reported making", () => {
    const failure = transportExhaustion([
      `stderr: API Error (529 ${OVERLOADED}) · Retrying in 1 seconds… (attempt 1/10)`,
      `stderr: API Error (529 ${OVERLOADED}) · Retrying in 8 seconds… (attempt 10/10)`,
    ]);
    expect(failure?.status).toBe(529);
    expect(failure?.retries).toBe(10);
  });

  it("reads the status the result envelope states in its own field", () => {
    const failure = transportExhaustion([
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 503,
        result: "the request could not be served",
      }),
    ]);
    expect(failure?.status).toBe(503);
    expect(failure?.message).toContain("could not be served");
  });

  it("reads a payload carried as a field rather than as a printed line", () => {
    const failure = transportExhaustion([
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }),
    ]);
    // No status was stated, and the provider's error type says which it was.
    expect(failure?.status).toBe(429);
    expect(failure?.message).toBe("Rate limited");
  });

  it("recognises a connection-level failure that never reached a status", () => {
    const failure = transportExhaustion(["stderr: API Error: Connection error."]);
    expect(failure).not.toBeNull();
    expect(failure?.status).toBeNull();
    expect(failure?.message).toBe("Connection error.");
  });

  it("takes the last failure, not the first: a blip recovered from did not end the attempt", () => {
    const failure = transportExhaustion([
      `stderr: API Error (529 ${OVERLOADED}) · Retrying in 1 seconds… (attempt 1/10)`,
      "stderr: API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"bad tool schema\"}}",
    ]);
    expect(failure).toBeNull();
  });
});

/**
 * The failure that ended the attempt, against the one the transport got over.
 *
 * Every 529 in a transcript is a 529, and most of them are the transport
 * working: it says it is retrying, it retries, and the agent goes on. Reading
 * one of those as the reason an attempt ended would name the provider for
 * somebody else's failure and hand the run a free extra attempt.
 */
describe("a retry the transport went on to serve", () => {
  const RETRYING = `API Error (529 ${OVERLOADED}) · Retrying in 1 seconds… (attempt 1/10)`;

  it("is not exhaustion: the agent said it had nine tries left", () => {
    expect(transportExhaustion([`stderr: ${RETRYING}`])).toBeNull();
  });

  it("does not become the reason when the agent later failed on its own", () => {
    expect(
      transportExhaustion([
        `stderr: ${RETRYING}`,
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "the executor stopped: the module the ticket names does not exist",
        }),
      ]),
    ).toBeNull();
  });

  it("does not become the reason when the agent went on working and the exit said nothing", () => {
    // No envelope at all — the agent took another turn after the blip and then
    // the process died. The turn is the proof the transport served it.
    expect(
      transportExhaustion([
        `stderr: API Error (529 ${OVERLOADED}) · Retrying in 8 seconds… (attempt 10/10)`,
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Retrying worked; the file is open now." }] },
        }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      ]),
    ).toBeNull();
  });

  it("is not exhaustion when the agent's own summary is the last word", () => {
    // The model finished a run and wrote a summary that opens with the text of
    // a 529 — a repository can contain that string, and a summary is the model
    // speaking rather than the transport.
    expect(
      transportExhaustion([
        `stderr: API Error (529 ${OVERLOADED}) · Retrying in 8 seconds… (attempt 10/10)`,
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: `API Error: 529 ${OVERLOADED} — that is the fixture I added.`,
        }),
      ]),
    ).toBeNull();
  });

  it("still leaves the exhausted case exhausted", () => {
    // The same blip, then the retries run out and the transport's last word is
    // a failure it did not say it would try again.
    const failure = transportExhaustion([
      `stderr: ${RETRYING}`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] },
      }),
      `stderr: API Error (529 ${OVERLOADED}) · Retrying in 8 seconds… (attempt 10/10)`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `API Error: 529 ${OVERLOADED}` }] },
      }),
    ]);
    expect(failure?.status).toBe(529);
    expect(failure?.retries).toBe(10);
  });

  it("is still exhaustion when the envelope after it states no reason of its own", () => {
    // `is_error` with nothing said is the exit code again, not a second
    // account of what went wrong, so the transport's last word stands.
    const failure = transportExhaustion([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `API Error: 529 ${OVERLOADED}` }] },
      }),
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }),
    ]);
    expect(failure?.status).toBe(529);
    expect(failure?.message).toBe("Overloaded");
  });
});

describe("what is not a transport failure", () => {
  it("leaves a refusal the transport would never retry alone", () => {
    expect(
      transportExhaustion([
        'stderr: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ]),
    ).toBeNull();
  });

  it("ignores an ordinary failure with nothing about the transport in it", () => {
    expect(
      transportExhaustion([
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "the executor stopped: the module the ticket names does not exist",
        }),
      ]),
    ).toBeNull();
  });

  it("does not let a file the agent read decide how the attempt terminated", () => {
    // The text of a 529 is a string a repository can contain — this very
    // suite contains it. Quoted in a tool call, in a file's contents or in the
    // middle of a sentence, it is not the transport speaking.
    expect(
      transportExhaustion([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Write",
                input: { file_path: "/w/fixture.ts", content: `API Error: 529 ${OVERLOADED}` },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: `The fixture asserts on "API Error: 529 ${OVERLOADED}".` },
            ],
          },
        }),
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "tests failed" }),
      ]),
    ).toBeNull();
  });
});

describe("what the record says", () => {
  it("names the last status and the transport's own error text", () => {
    const failure = transportExhaustion([
      `stderr: API Error (529 ${OVERLOADED}) · Retrying in 8 seconds… (attempt 10/10)`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `API Error: 529 ${OVERLOADED}` }] },
      }),
    ]);
    const detail = describeTransportFailure(failure!, { code: 1, signal: null });
    expect(detail).toContain("529");
    expect(detail).toContain("overloaded_error");
    expect(detail).toContain("Overloaded");
    expect(detail).toContain("10 reported retries");
    expect(detail).toContain("exited 1");
  });
});

/**
 * The provider's own words are tool output, recorded and shown whole
 * (D-NEW-nothing-shown-is-cut): the evidence a failure was read from and the
 * sentence that named its reset, however long either runs.
 */
describe("the transport's words, whole", () => {
  it("keeps the whole line a failure was read from as its evidence", () => {
    const padding = "the upstream said more than a line's worth here, ".repeat(20);
    const line = `stderr: API Error (529 ${OVERLOADED}) ${padding}and this is its last word`;
    const failure = transportExhaustion([line]);
    expect(failure?.evidence.length).toBeGreaterThan(500);
    expect(failure?.evidence.endsWith("and this is its last word")).toBe(true);
  });

  it("quotes the whole sentence that named the reset", () => {
    const long = "You've hit your session limit for the plan you are on, " + "which covers every model ".repeat(15);
    const text = `429 ${long}and resets 4:30am (Europe/London)`;
    const reset = resetInText(text, new Date("2026-09-25T01:00:00Z"));
    expect(reset?.quoted.length).toBeGreaterThan(300);
    expect(reset?.quoted.endsWith("resets 4:30am (Europe/London)")).toBe(true);
  });
});
