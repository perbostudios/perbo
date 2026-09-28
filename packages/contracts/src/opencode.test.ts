import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortFits } from "./effort.js";
import {
  awaitOpenCodeModel,
  OPENCODE_SESSION_ATTEMPTS,
  opencodeConfig,
  opencodeEnvironment,
  opencodeInstructionsPath,
  opencodePermissions,
  opencodeToolName,
  opencodeVersionFits,
} from "./opencode.js";

describe("how every role starts OpenCode (D-134)", () => {
  it("asks about every command, file change and reach outside, and denies every other tool, for the executor and the chat", () => {
    for (const role of ["executor", "interview"] as const) {
      const rules = opencodePermissions(role, ["read_plan"]);
      expect(Object.keys(rules)[0]).toBe("*");
      expect(rules).toMatchObject({ "*": "deny", bash: "ask", edit: "ask", external_directory: "ask", read: "allow" });
    }
    // Only the chat is given its own tools, each by its exact name.
    expect(opencodePermissions("interview", ["read_plan"])).toMatchObject({ perbo_interview_read_plan: "allow" });
    expect(opencodePermissions("executor", ["read_plan"])).not.toHaveProperty("perbo_interview_read_plan");
    expect(opencodeToolName("edit_plan")).toBe("perbo_interview_edit_plan");
  });

  it("gives the reviewer nothing it can use", () => {
    expect(opencodePermissions("reviewer")).toEqual({ "*": "deny", read: "allow", bash: "ask", external_directory: "deny" });
  });

  it("switches off every tool server, plugin, formatter, language server, share and update, and names the chat's tool server alone", () => {
    const executor = JSON.parse(opencodeConfig("executor")) as Record<string, unknown>;
    expect(executor).toMatchObject({
      mcp: {},
      plugin: [],
      instructions: [],
      formatter: false,
      lsp: false,
      share: "disabled",
      autoupdate: false,
      snapshot: false,
    });
    // The executor is never given a tool server, whatever it is handed.
    expect(JSON.parse(opencodeConfig("executor", { url: "http://127.0.0.1:1/mcp", token: "t", names: ["x"] })).mcp).toEqual({});
    const chat = JSON.parse(opencodeConfig("interview", { url: "http://127.0.0.1:1/mcp", token: "t", names: ["read_plan"] }));
    expect(chat.mcp).toEqual({
      servers: {
        perbo_interview: {
          type: "remote",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer t" },
          oauth: false,
          codemode: false,
        },
      },
    });
  });

  it("keeps OpenCode's directories under the role's own, with the project's configuration off", () => {
    const env = opencodeEnvironment("/r", "{}");
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: "/r/config",
      XDG_DATA_HOME: "/r/data",
      XDG_STATE_HOME: "/r/state",
      XDG_CACHE_HOME: "/r/cache",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: "{}",
    });
    expect(opencodeInstructionsPath("/r")).toBe("/r/config/opencode/AGENTS.md");
  });

  it("reads an OpenCode version and holds it to 2.0.14, the build it was measured on", () => {
    expect(opencodeVersionFits("opencode v2.0.14")).toBe(true);
    expect(opencodeVersionFits("2.0.14")).toBe(true);
    expect(opencodeVersionFits("2.0.13")).toBe(false);
    expect(opencodeVersionFits("2.0.0")).toBe(false);
    expect(opencodeVersionFits("3.1.0")).toBe(true);
    expect(opencodeVersionFits("1.18.32")).toBe(false);
    expect(opencodeVersionFits("opencode")).toBe(false);
    expect(opencodeVersionFits(null)).toBe(false);
  });

  it("takes no effort level", () => {
    expect(EFFORT_LEVELS["opencode-cli"]).toEqual([]);
    expect(effortFits("opencode-cli", "low")).toBe(false);
  });
});

describe("waiting until OpenCode offers a model", () => {
  /** OpenCode's answer refusing a request, as a transport rejects with it. */
  class Refusal extends Error {}
  const refused = (error: unknown) => error instanceof Refusal;

  /**
   * An ACP server whose first `stale` sessions lack `model` and name another
   * default, as one opened before OpenCode's catalogue settles does; `answers`
   * stands in for a session's answer by its number, from 1.
   */
  const server = (stale: number, model = "opencode/longcat", answers: Record<number, () => Promise<unknown>> = {}) => {
    const calls: Array<[string, unknown]> = [];
    let opened = 0;
    return {
      calls,
      request: async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === "session/delete") return {};
        opened += 1;
        const answer = answers[opened];
        if (answer !== undefined) return answer();
        const settled = opened > stale;
        const offered = settled ? [{ value: model }, { value: "opencode/other" }] : [{ value: "opencode/other" }];
        return {
          sessionId: `s${opened}`,
          configOptions: [{ id: "model", currentValue: settled ? model : "opencode/other", options: offered }],
        };
      },
    };
  };
  let directory = 0;
  const scratch = () => `/scratch/${(directory += 1)}`;
  const wait = async () => undefined;
  const opened = (acp: ReturnType<typeof server>) => acp.calls.filter(([method]) => method === "session/new");

  it("opens sessions in fresh directories until one offers the model, deleting each", async () => {
    const acp = server(1);
    await expect(awaitOpenCodeModel({ model: "opencode/longcat", scratch, request: acp.request, refused, wait })).resolves.toBe(
      "opencode/longcat",
    );
    const cwds = opened(acp).map(([, params]) => (params as { cwd: string }).cwd);
    expect(cwds).toHaveLength(2);
    expect(new Set(cwds).size).toBe(2);
    expect(acp.calls.filter(([method]) => method === "session/delete").map(([, params]) => params)).toEqual([
      { sessionId: "s1" },
      { sessionId: "s2" },
    ]);
  });

  it("says the model was not found once every snapshot has lacked it", async () => {
    const acp = server(99);
    await expect(awaitOpenCodeModel({ model: "opencode/longcat", scratch, request: acp.request, refused, wait })).rejects.toThrow(
      `OpenCode did not offer opencode/longcat in ${OPENCODE_SESSION_ATTEMPTS} catalogues: model not found`,
    );
    expect(opened(acp)).toHaveLength(OPENCODE_SESSION_ATTEMPTS);
  });

  it("with no model named, answers with the default once two snapshots in a row name it", async () => {
    // The first snapshot names the unsettled default; the next two the settled one.
    const acp = server(1);
    await expect(awaitOpenCodeModel({ model: null, scratch, request: acp.request, refused, wait })).resolves.toBe(
      "opencode/longcat",
    );
    expect(opened(acp)).toHaveLength(3);
  });

  it("with no model named, says so where no two snapshots in a row agree", async () => {
    let flip = 0;
    const answers = Object.fromEntries(
      Array.from({ length: OPENCODE_SESSION_ATTEMPTS }, (_, at) => [
        at + 1,
        async () => ({ sessionId: `f${at}`, configOptions: [{ id: "model", currentValue: `opencode/m${(flip += 1) % 2}` }] }),
      ]),
    );
    const acp = server(0, "opencode/longcat", answers);
    await expect(awaitOpenCodeModel({ model: null, scratch, request: acp.request, refused, wait })).rejects.toThrow(
      `OpenCode's catalogue did not settle on a default model in ${OPENCODE_SESSION_ATTEMPTS} catalogues`,
    );
    expect(opened(acp)).toHaveLength(OPENCODE_SESSION_ATTEMPTS);
  });

  it("with no model named, takes two snapshots with a refused session between them as agreeing", async () => {
    const refusal = new Refusal("Internal error: Internal service failure");
    const acp = server(0, "opencode/longcat", { 2: async () => Promise.reject(refusal) });
    await expect(awaitOpenCodeModel({ model: null, scratch, request: acp.request, refused, wait })).resolves.toBe(
      "opencode/longcat",
    );
    expect(opened(acp)).toHaveLength(3);
  });

  it("counts a session OpenCode refused toward the sessions it may open, and throws the last refusal as it came", async () => {
    const refusal = new Refusal("Internal error: Internal service failure");
    const once = server(0, "opencode/longcat", { 1: async () => Promise.reject(refusal) });
    await expect(awaitOpenCodeModel({ model: "opencode/longcat", scratch, request: once.request, refused, wait })).resolves.toBe(
      "opencode/longcat",
    );
    expect(opened(once)).toHaveLength(2);
    const always = server(0, "opencode/longcat", {
      ...Object.fromEntries(Array.from({ length: OPENCODE_SESSION_ATTEMPTS }, (_, at) => [at + 1, async () => Promise.reject(refusal)])),
    });
    await expect(awaitOpenCodeModel({ model: "opencode/longcat", scratch, request: always.request, refused, wait })).rejects.toBe(
      refusal,
    );
    expect(opened(always)).toHaveLength(OPENCODE_SESSION_ATTEMPTS);
  });

  it("throws at once, unchanged, a failure that is not OpenCode's answer: the process gone or a request timed out", async () => {
    for (const model of ["opencode/longcat", null]) {
      const gone = new Error("OpenCode stopped before completing (1): panic: database is locked");
      const acp = server(0, "opencode/longcat", { 1: async () => Promise.reject(gone) });
      await expect(awaitOpenCodeModel({ model, scratch, request: acp.request, refused, wait })).rejects.toBe(gone);
      expect(opened(acp)).toHaveLength(1);
    }
  });
});
