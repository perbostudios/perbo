import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { preflight } from "../src/preflight.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./support.js";

/** An environment whose PATH holds nothing, so every binary check fails. */
function bare(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: mkdtempSync(join(tmpdir(), "perbo-preflight-empty-")), ...extra };
}

/** A binary whose `--version` prints the `codex-cli X.Y.Z` line the real one does, at a chosen version. */
function fakeCodex(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-preflight-codex-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return binary;
}

/** A binary whose `--version` prints exactly this line — no `codex-cli ` prefix implied. */
function fakeVersionLine(line: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-preflight-version-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
  return binary;
}

describe("preflight", () => {
  it("warns about a missing gh when the run does not publish, and blocks when it does", () => {
    const quiet = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(quiet.ok).toBe(true);
    expect(quiet.findings.map((f) => [f.reason, f.severity])).toEqual([["gh_missing", "warning"]]);
    expect(quiet.tools.gh?.present).toBe(false);

    const publishing = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: true,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(publishing.ok).toBe(false);
    expect(publishing.findings.map((f) => [f.reason, f.severity])).toEqual([["gh_missing", "blocking"]]);
  });

  it("names the credential a reviewer provider needs, with its fix", () => {
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare(),
    });
    const credential = result.findings.find((f) => f.reason === "reviewer_credential_missing");
    expect(credential?.severity).toBe("blocking");
    expect(credential?.fix).toContain("ANTHROPIC_API_KEY");
  });

  it("blocks on a missing agent binary and git when the run needs them", () => {
    const result = preflight({
      agentBinary: "claude",
      agentProvider: "claude-cli",
      reviewerProvider: "claude-cli",
      needsGh: false,
      env: bare(),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.reason)).toEqual(
      expect.arrayContaining(["git_missing", "agent_binary_missing"]),
    );
  });

  it("blocks on the binary the manifest installs with, and names it in the tools", () => {
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      installBinary: "pnpm",
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.reason === "install_binary_missing");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("pnpm");
    // The row is what a person pastes into an issue; a binary checked and not
    // reported is a check nobody can read.
    expect(result.tools.pnpm?.present).toBe(false);
  });

  it("asks nothing about an install a run without a worktree never performs", () => {
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      installBinary: "pnpm",
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.findings.map((f) => f.reason)).not.toContain("install_binary_missing");
    expect(result.tools.pnpm).toBeUndefined();
  });

  it("passes when the install binary can actually be spawned", () => {
    // `node` stands in for the manifest's package manager: a real executable,
    // found the same argv-only way the runner will spawn the install itself.
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      installBinary: process.execPath,
      env: { ...process.env, ANTHROPIC_API_KEY: "set" },
    });
    expect(result.findings.map((f) => f.reason)).not.toContain("install_binary_missing");
    expect(result.tools[process.execPath]?.present).toBe(true);
  });

  it("refuses a Codex agent binary older than 0.145.0, naming both versions (D-106)", () => {
    const result = preflight({
      agentBinary: fakeCodex("0.144.0"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.reason === "codex_too_old");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("0.144.0");
    expect(finding?.detail).toContain("0.145.0");
    expect(finding?.detail).toContain("is below");
    // A parsed version, unlike "nightly", was ordered against the floor.
    expect(finding?.detail).not.toContain("could not be read");
  });

  it("allows a Codex agent binary at exactly 0.145.0 (D-106)", () => {
    const result = preflight({
      agentBinary: fakeCodex("0.145.0"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.findings.map((f) => f.reason)).not.toContain("codex_too_old");
  });

  it("refuses a prerelease of the floor, which semver orders below it, and allows a prerelease of a later version (D-106)", () => {
    const below = preflight({
      agentBinary: fakeCodex("0.145.0-rc.1"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(below.findings.find((f) => f.reason === "codex_too_old")?.detail).toContain("0.145.0-rc.1");
    const above = preflight({
      agentBinary: fakeCodex("0.146.0-alpha.1"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(above.findings.map((f) => f.reason)).not.toContain("codex_too_old");
  });

  it("refuses a Codex whose version line cannot be read as one, naming what it printed (D-106)", () => {
    const result = preflight({
      agentBinary: fakeCodex("nightly"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    const finding = result.findings.find((f) => f.reason === "codex_too_old");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("nightly");
    // Not "is below": a line that does not parse as a version was never
    // ordered against the floor, so nothing here can say where below it.
    expect(finding?.detail).toContain("could not be read as a version");
    expect(finding?.detail).not.toContain("is below");
  });

  it("refuses a too-old Codex reviewer binary the same way (D-106)", () => {
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: "codex-cli",
      needsGh: false,
      needsGit: false,
      env: bare({ PERBO_CODEX_BINARY: fakeCodex("0.100.0") }),
    });
    const finding = result.findings.find((f) => f.reason === "codex_too_old");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("0.100.0");
  });

  it("reports a too-old Codex binary once, even where it is both the agent and the reviewer (D-106)", () => {
    const binary = fakeCodex("0.100.0");
    const result = preflight({
      agentBinary: binary,
      agentProvider: "codex-cli",
      reviewerProvider: "codex-cli",
      needsGh: false,
      needsGit: false,
      env: bare({ PERBO_CODEX_BINARY: binary }),
    });
    expect(result.findings.filter((f) => f.reason === "codex_too_old")).toHaveLength(1);
  });

  it("reports a too-old Codex binary once when it is named two ways that resolve to the same file (D-106)", () => {
    const binary = fakeCodex("0.100.0");
    const result = preflight({
      agentBinary: binary,
      agentProvider: "codex-cli",
      reviewerProvider: "codex-cli",
      needsGh: false,
      needsGit: false,
      // No PERBO_CODEX_BINARY: the reviewer falls back to bare `codex`,
      // resolved through PATH to the same file `agentBinary` names in full.
      env: { PATH: dirname(binary) },
    });
    expect(result.findings.filter((f) => f.reason === "codex_too_old")).toHaveLength(1);
  });

  it("refuses a Codex agent binary whose version line carries no `codex-cli ` prefix, naming what it printed (D-106)", () => {
    const result = preflight({
      agentBinary: fakeVersionLine("codex 0.145.0"),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    const finding = result.findings.find((f) => f.reason === "codex_too_old");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("codex 0.145.0");
  });

  it("refuses a Codex agent binary whose version line is empty (D-106)", () => {
    const result = preflight({
      agentBinary: fakeVersionLine(""),
      agentProvider: "codex-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.findings.find((f) => f.reason === "codex_too_old")?.severity).toBe("blocking");
  });

  it("does not check a Claude agent's version against the Codex floor, at whatever path it is configured", () => {
    const result = preflight({
      agentBinary: fakeVersionLine("claude-code 2.1.247"),
      agentProvider: "claude-cli",
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(result.findings.map((f) => f.reason)).not.toContain("codex_too_old");
  });

  it("falls back to the version line's own codex-cli prefix where the provider is not given", () => {
    const prefixed = preflight({
      agentBinary: fakeCodex("0.144.0"),
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    const finding = prefixed.findings.find((f) => f.reason === "codex_too_old");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("0.144.0");

    const unprefixed = preflight({
      agentBinary: fakeVersionLine("claude-code 2.1.247"),
      agentProvider: null,
      reviewerProvider: "anthropic",
      needsGh: false,
      needsGit: false,
      env: bare({ ANTHROPIC_API_KEY: "set" }),
    });
    expect(unprefixed.findings.map((f) => f.reason)).not.toContain("codex_too_old");
  });

  it("still asks whether claude is on PATH when the agent is Claude at a configured path, not literally `claude`", () => {
    const result = preflight({
      agentBinary: fakeVersionLine("claude-code 2.1.247"),
      agentProvider: "claude-cli",
      reviewerProvider: "claude-cli",
      needsGh: false,
      needsGit: false,
      // PATH holds nothing but the agent's own configured binary above: the
      // reviewer spawns the bare `claude` command on its own, independently
      // of where the agent is configured, so that lookup still has to run.
      env: bare(),
    });
    expect(result.findings.find((f) => f.reason === "reviewer_binary_missing")?.severity).toBe(
      "blocking",
    );
  });

  it("does not ask separately whether claude is on PATH once the agent binary already is literally `claude`", () => {
    const dir = mkdtempSync(join(tmpdir(), "perbo-preflight-claude-literal-"));
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "1.2.3 (Claude Code)"\n`, { mode: 0o755 });
    const result = preflight({
      agentBinary: "claude",
      agentProvider: "claude-cli",
      reviewerProvider: "claude-cli",
      needsGh: false,
      needsGit: false,
      // The one lookup the agent check already made answers the reviewer's
      // question too — the same bare `claude` command either way.
      env: { PATH: dir },
    });
    expect(result.findings.map((f) => f.reason)).not.toContain("reviewer_binary_missing");
  });
}, SPAWN_TEST_TIMEOUT_MS);
