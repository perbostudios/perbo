import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortFits } from "./effort.js";
import {
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
