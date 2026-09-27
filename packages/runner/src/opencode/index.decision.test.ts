import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import type { PreToolGuardState } from "../pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../profile.js";
import { opencodeDecision, opencodeWritePaths } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");
const root = scratch("perbo-opencode-decision-");
mkdirSync(join(root, "src"), { recursive: true });

const state = (): PreToolGuardState => ({
  root,
  tmpdir: join(root, ".perbo-tmp"),
  cwd: root,
  paths_allowed: ["src/**"],
  paths_prohibited: ["src/secret/**"],
  allow_list: [...DEFAULT_COMMAND_ALLOW_LIST],
  deny_list: [...DEFAULT_COMMAND_DENY_LIST],
});

const call = (kind: string, rawInput: Record<string, unknown>, locations: string[] = []) => ({
  toolCallId: "t",
  kind,
  rawInput,
  locations: locations.map((path) => ({ path })),
});

describe("what the runner's guard says to an OpenCode call", () => {
  it("admits a read-only command and a write inside the contract's paths", () => {
    expect(opencodeDecision(call("execute", { command: "ls src", cwd: root }), state())).toEqual({ decision: "allowed" });
    expect(opencodeDecision(call("edit", { filePath: join(root, "src/a.ts") }), state())).toEqual({ decision: "allowed" });
  });

  it("refuses a command that writes outside the worktree, one outside it, and one it cannot name", () => {
    expect(opencodeDecision(call("execute", { command: "touch /etc/perbo" }), state())).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
    });
    expect(opencodeDecision(call("execute", { command: "ls", cwd: "/tmp" }), state())).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
    });
    expect(opencodeDecision(call("execute", {}), state())).toMatchObject({ decision: "denied" });
    expect(opencodeDecision(call("execute", { command: "curl https://example.com" }), state())).toMatchObject({
      decision: "denied",
    });
  });

  it("judges a file change on every path it names, the destination of a move and a patch's headers included", () => {
    expect(opencodeDecision(call("edit", { filePath: "docs/a.md" }), state())).toMatchObject({
      decision: "denied",
      rule: "write_outside_scope",
    });
    expect(opencodeDecision(call("edit", { filePath: "src/secret/key.ts" }), state())).toMatchObject({
      decision: "denied",
      rule: "write_prohibited_path",
    });
    // A move out of scope, named only by where it lands.
    expect(
      opencodeDecision(call("move", { files: [{ file: "src/a.ts", movePath: "docs/a.ts" }] }), state()),
    ).toMatchObject({ decision: "denied", target: join(root, "docs/a.ts") });
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-a",
      "+b",
      "*** Add File: .github/workflows/x.yml",
      "+on: push",
      "*** End Patch",
    ].join("\n");
    expect(opencodeWritePaths(call("edit", { patchText: patch }))).toEqual(["src/a.ts", ".github/workflows/x.yml"]);
    expect(opencodeDecision(call("edit", { patchText: patch }), state())).toMatchObject({ decision: "denied" });
    // A change that names no file at all is refused rather than guessed at.
    expect(opencodeDecision(call("edit", {}), state())).toMatchObject({ decision: "denied" });
  });

  it("admits a read inside the worktree and refuses one outside it", () => {
    expect(opencodeDecision(call("read", {}, [join(root, "src/a.ts")]), state())).toEqual({ decision: "allowed" });
    expect(opencodeDecision(call("read", {}, ["/Users/someone/.ssh/id_ed25519"]), state())).toMatchObject({
      decision: "denied",
      rule: "read_outside_worktree",
    });
  });

  it("refuses a kind of call the runner is not built to judge", () => {
    expect(opencodeDecision({ ...call("fetch", { url: "https://example.com" }), title: "webfetch" }, state())).toMatchObject({
      decision: "denied",
      target: "webfetch",
    });
  });
});
