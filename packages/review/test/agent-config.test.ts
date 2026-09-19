import { describe, expect, it } from "vitest";
import { changeSetFromDiff } from "@perbo/contracts";
import { assessAgentConfiguration } from "../src/agent-config.js";

const diffFor = (paths: string[]) =>
  paths
    .map(
      (path) => `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/${path}
@@ -0,0 +1,1 @@
+{}
`,
    )
    .join("");

const assess = (paths: string[]) =>
  assessAgentConfiguration(changeSetFromDiff({ diff: diffFor(paths), base_commit: "a1b2c3d" }));

describe("repository-supplied agent configuration fails closed", () => {
  it.each([
    ".claude/settings.json",
    ".mcp.json",
    "packages/a/.claude/hooks/pre.sh",
    "AGENTS.md",
    "CLAUDE.md",
    ".cursor/rules",
  ])("blocks on %s", (path) => {
    const result = assess([path]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.blocking).toBe(true);
    expect(result.findings[0]?.rule_id).toBe("security.agent_configuration");
    expect(result.check.status).toBe("failed");
  });

  it("blocks a hook, a tool-server manifest and a base-URL override together", () => {
    const result = assess([".claude/settings.json", ".mcp.json", ".claude/hooks/pre-tool.sh"]);
    expect(result.findings).toHaveLength(3);
    expect(result.findings.every((finding) => finding.blocking)).toBe(true);
  });

  it("passes an ordinary change", () => {
    const result = assess(["packages/a/src/a.ts", "packages/a/README.md"]);
    expect(result.findings).toEqual([]);
    expect(result.check.status).toBe("passed");
  });

  it("says why, in a statement that stands alone", () => {
    const [finding] = assess([".claude/settings.json"]).findings;
    expect(finding?.statement).toMatch(/ADR-0030/);
    expect(finding?.statement).toMatch(/egress|execution/);
  });

  it("keeps a stable key across runs", () => {
    expect(assess([".mcp.json"]).findings[0]?.key).toBe(assess([".mcp.json"]).findings[0]?.key);
  });
});
