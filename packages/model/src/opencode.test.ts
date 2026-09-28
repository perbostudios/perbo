import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENCODE_SESSION_RETRY_MS } from "@perbo/contracts";
import { ProviderError } from "./failure.js";
import { openCodeCliModel, openCodeStructured } from "./opencode.js";
import { fakeOpenCodeReviewer } from "./test-support/fake-opencode.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./test-support/spawn-timeout.js";

const submitSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const request = (forceSubmit = false) => ({
  system: "THE REVIEWER'S SYSTEM PROMPT",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit,
});

const read = JSON.stringify({ next: "read_files", read_paths: ["src/a.ts"], review: null });
const verdict = JSON.stringify({ next: "submit_review", read_paths: [], review: { ok: true } });

/** Every line the fake received, and how it was started. */
function logOf(log: string): { started: { argv: string[]; env: Record<string, string> }; lines: Array<Record<string, unknown>> } {
  const [started, ...lines] = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { started: started as unknown as { argv: string[]; env: Record<string, string> }, lines };
}

describe("the opencode-cli reviewer transport", () => {
  it(
    "reads a request for files and a verdict out of OpenCode's answers, and each turn's own dollars out of its running total",
    async () => {
      const fake = fakeOpenCodeReviewer([
        { text: read, cost: 0.002 },
        { text: "```json\n" + verdict + "\n```", cost: 0.005 },
      ]);
      const model = openCodeCliModel({ submitSchema, binary: fake.binary, modelId: "opencode/big-pickle" });
      const first = await model.turn(request());
      expect(first.toolCalls).toEqual([{ id: "cli_read_0", name: "read_file", input: { path: "src/a.ts" } }]);
      expect(first.reported_cost_micros).toBe(2_000);
      expect(first.usage).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 0,
      });
      const second = await model.turn(request(true));
      expect(second.toolCalls).toEqual([{ id: "cli_submit", name: "submit_review", input: { ok: true } }]);
      expect(second.reported_cost_micros).toBe(3_000);
      const { started, lines } = logOf(fake.log);
      expect(started.argv).toEqual(["acp"]);
      expect(started.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
      expect(JSON.parse(started.env["OPENCODE_CONFIG_CONTENT"]!).permission["*"]).toBe("deny");
      // One scratch session for the catalogue, deleted, then the review's
      // own, both turns in it, the model asked for selected.
      expect(lines.filter((line) => line["method"] === "session/new")).toHaveLength(2);
      expect(lines.filter((line) => line["method"] === "session/delete")).toHaveLength(1);
      expect(lines.filter((line) => line["method"] === "session/prompt")).toHaveLength(2);
      expect(model.provider).toBe("opencode-cli");
      expect(model.unreported_cost_basis).toBe("unavailable");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "reports no dollars for a turn OpenCode sent no usage for",
    async () => {
      const fake = fakeOpenCodeReviewer([{ text: verdict }]);
      const turn = await openCodeCliModel({ submitSchema, binary: fake.binary }).turn(request());
      expect(turn.reported_cost_micros).toBeUndefined();
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "fails a turn whose answer is prose around JSON rather than read a verdict out of it",
    async () => {
      const fake = fakeOpenCodeReviewer([{ text: `I approve. ${verdict}` }]);
      await expect(openCodeCliModel({ submitSchema, binary: fake.binary }).turn(request())).rejects.toThrow(
        "OpenCode did not answer with one JSON object",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "fails a turn in which the reviewer called a tool or was asked about one, and rejects the call",
    async () => {
      const tool = fakeOpenCodeReviewer([{ text: verdict, tool: true }]);
      await expect(openCodeCliModel({ submitSchema, binary: tool.binary }).turn(request())).rejects.toThrow(
        "OpenCode offered the isolated reviewer a tool",
      );
      const asked = fakeOpenCodeReviewer([{ text: verdict, permission: true }]);
      await expect(openCodeCliModel({ submitSchema, binary: asked.binary }).turn(request())).rejects.toBeInstanceOf(
        ProviderError,
      );
      const answer = logOf(asked.log).lines.find((line) => line["id"] === "ask");
      expect(answer?.["result"]).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a session that loaded an agent definition, or selected another model",
    async () => {
      const loaded = fakeOpenCodeReviewer([{ text: verdict }], { modes: ["build", "plan", "injected"] });
      await expect(openCodeCliModel({ submitSchema, binary: loaded.binary }).turn(request())).rejects.toThrow(
        "OpenCode loaded agent definitions in the isolated reviewer: injected",
      );
      const other = fakeOpenCodeReviewer([{ text: verdict }], { selects: "opencode/other" });
      await expect(
        openCodeCliModel({ submitSchema, binary: other.binary, modelId: "opencode/big-pickle" }).turn(request()),
      ).rejects.toThrow("instead of registered opencode/big-pickle");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("the review's session and OpenCode's catalogue", () => {
  it(
    "opens the review's session only once a scratch session's catalogue offers the model, so a stale first snapshot cannot refuse it",
    async () => {
      const fake = fakeOpenCodeReviewer([{ text: verdict }], { staleSnapshots: 1 });
      const turn = await openCodeCliModel({ submitSchema, binary: fake.binary, modelId: "opencode/big-pickle" }).turn(request());
      expect(turn.toolCalls.map((call) => call.name)).toEqual(["submit_review"]);
      const { lines } = logOf(fake.log);
      const opened = lines.filter((line) => line["method"] === "session/new").map((line) => (line["params"] as { cwd: string }).cwd);
      expect(opened).toHaveLength(3);
      expect(opened[0]).toContain("catalogue-");
      expect(opened[1]).toContain("catalogue-");
      expect(opened[2]!.endsWith("/scratch")).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "asks again for a session OpenCode refused while its catalogue was still arriving, the catalogue's or the review's",
    async () => {
      // The first scratch session is refused, the second offers the model, and
      // the review's own is refused once before it opens.
      const fake = fakeOpenCodeReviewer([{ text: verdict }], { refuseSessions: [1, 3] });
      const turn = await openCodeCliModel({ submitSchema, binary: fake.binary, modelId: "opencode/big-pickle" }).turn(request());
      expect(turn.toolCalls.map((call) => call.name)).toEqual(["submit_review"]);
      const opened = logOf(fake.log)
        .lines.filter((line) => line["method"] === "session/new")
        .map((line) => (line["params"] as { cwd: string }).cwd);
      expect(opened).toHaveLength(4);
      expect(opened.slice(0, 2).every((cwd) => cwd.includes("catalogue-"))).toBe(true);
      expect(opened.slice(2).every((cwd) => cwd.endsWith("/scratch"))).toBe(true);
    },
    // Spawns the fake, and waits OPENCODE_SESSION_RETRY_MS before each of the two sessions asked again.
    SPAWN_TEST_TIMEOUT_MS + 2 * OPENCODE_SESSION_RETRY_MS,
  );
});

describe("an OpenCode that stops", () => {
  it(
    "fails the review with why OpenCode stopped, as soon as it stops opening the catalogue's session or the review's",
    async () => {
      // The first session is the catalogue's scratch one, the second the review's own.
      for (const nth of [1, 2]) {
        const fake = fakeOpenCodeReviewer([{ text: verdict }], { exit: { method: "session/new", nth, answered: false } });
        const started = Date.now();
        await expect(openCodeCliModel({ submitSchema, binary: fake.binary }).turn(request())).rejects.toThrow(
          "OpenCode exited before the review completed (3): opencode crashed",
        );
        // No session asked for after the process was gone.
        expect(logOf(fake.log).lines.filter((line) => line["method"] === "session/new")).toHaveLength(nth);
        expect(Date.now() - started).toBeLessThan(5_000);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a request made after OpenCode stopped at once, with why it stopped, rather than wait out its timeout",
    async () => {
      const fake = fakeOpenCodeReviewer([{ text: read }, { text: verdict }], {
        exit: { method: "session/prompt", nth: 1, answered: true },
      });
      const model = openCodeCliModel({ submitSchema, binary: fake.binary });
      expect((await model.turn(request())).toolCalls.map((call) => call.name)).toEqual(["read_file"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = Date.now();
      await expect(model.turn(request())).rejects.toThrow("OpenCode exited before the review completed (3): opencode crashed");
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("openCodeStructured", () => {
  it("reads one JSON object, bare or alone in one fenced block, and nothing else", () => {
    expect(openCodeStructured(verdict)).toMatchObject({ next: "submit_review" });
    expect(openCodeStructured("```json\n" + verdict + "\n```")).toMatchObject({ next: "submit_review" });
    expect(openCodeStructured(`Here it is:\n\`\`\`json\n${verdict}\n\`\`\``)).toBeNull();
    expect(openCodeStructured("[1]")).toBeNull();
    expect(openCodeStructured("approve")).toBeNull();
  });
});
