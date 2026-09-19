import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexCommandDecision,
  codexFileDecision,
} from "../src/adapter-codex.js";
import { buildPermissionProfile } from "../src/profile.js";
import { TicketRunConfigSchema } from "../src/loop.js";
import type { PreToolGuardState } from "../src/pretool.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function state(): PreToolGuardState {
  const root = mkdtempSync(join(tmpdir(), "perbo-codex-guard-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  const profile = buildPermissionProfile({ worktree: root });
  return {
    root,
    cwd: root,
    tmpdir: null,
    paths_allowed: ["src/**"],
    paths_prohibited: [],
    allow_list: profile.command_allow_list,
    deny_list: profile.command_deny_list,
  };
}
describe("Codex runner action boundary", () => {
  it("allows an in-scope file write and refuses an out-of-scope one before execution", () => {
    const guard = state();
    expect(codexFileDecision("src/example.ts", guard).decision).toBe("allowed");
    expect(codexFileDecision("README.md", guard)).toMatchObject({
      decision: "denied",
      rule: "write_outside_scope",
    });
  });
  it("refuses parent paths, git metadata and symlink escapes", () => {
    const guard = state();
    expect(codexFileDecision("../outside", guard).decision).toBe("denied");
    expect(codexFileDecision(".git/config", guard).decision).toBe("denied");
    symlinkSync(tmpdir(), join(guard.root, "src", "linked"));
    expect(codexFileDecision("src/linked/outside", guard).decision).toBe(
      "denied",
    );
  });
  it("refuses publication, shell wrappers and credential mutations", () => {
    const guard = state();
    for (const command of [
      "git push",
      "gh auth logout",
      "bash -c 'touch /tmp/escaped'",
      "git config credential.helper bad",
    ])
      expect(codexCommandDecision(command, guard.cwd, guard).decision).toBe(
        "denied",
      );
  });
  it("admits a read-only command with quoted arguments as one argv", () => {
    const guard = state();
    expect(
      codexCommandDecision("git status --short", guard.cwd, guard).decision,
    ).toBe("allowed");
    expect(
      codexCommandDecision(
        '/bin/zsh -lc "cat src/a.ts && printf ok && find src -type f"',
        guard.cwd,
        guard,
      ).decision,
    ).toBe("allowed");
    expect(
      codexCommandDecision(
        '/bin/zsh -lc "cat src/a.ts && git push"',
        guard.cwd,
        guard,
      ).decision,
    ).toBe("denied");
    expect(
      codexCommandDecision("git status --short", tmpdir(), guard).decision,
    ).toBe("denied");
  });
  it("validates both subscription providers without changing legacy defaults", () => {
    const required = {
      ticket_key: "PRB-1",
      repository_root: "/repo",
      worktree_root: "/worktree",
      bundle_root: "/bundles",
      quarantine_root: "/quarantine",
      state_root: "/state",
    };
    expect(TicketRunConfigSchema.parse(required).agent_provider).toBe(
      "claude-cli",
    );
    expect(
      TicketRunConfigSchema.parse({
        ...required,
        agent_provider: "codex-cli",
        agent_binary: "codex",
        reviewer_provider: "codex-cli",
      }).reviewer_provider,
    ).toBe("codex-cli");
    expect(
      TicketRunConfigSchema.parse({ ...required, agent_provider: "codex-cli" }),
    ).toMatchObject({ agent_binary: "codex", model: "gpt-5.6-terra" });
    expect(
      buildPermissionProfile({ worktree: "/repo", provider: "codex-cli" })
        .provider_base_url,
    ).toContain("chatgpt.com");
  });
});
