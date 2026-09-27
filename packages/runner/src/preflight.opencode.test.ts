import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { preflight, renderPreflight } from "./preflight.js";

const scratch = scratchDirectories("perbo-runner-");

/** An `opencode` whose `--version` prints the line the real one does, at a chosen version. */
function fakeOpenCode(version: string): string {
  const dir = scratch("perbo-preflight-opencode-");
  const binary = join(dir, "opencode");
  writeFileSync(binary, `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 });
  return binary;
}

const bare = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: scratch("perbo-preflight-empty-"),
  ...extra,
});

describe("preflight on OpenCode", () => {
  it(
    "prints the OpenCode the executor runs, and says once that without OPENCODE_API_KEY it runs only free models",
    () => {
      const binary = fakeOpenCode("2.0.14");
      const result = preflight({
        agentBinary: binary,
        agentProvider: "opencode-cli",
        reviewerProvider: "opencode-cli",
        needsGh: false,
        needsGit: false,
        env: bare({ PERBO_OPENCODE_BINARY: binary }),
      });
      expect(result.tools[binary]).toEqual({ present: true, version: "opencode v2.0.14" });
      expect(renderPreflight(result)).toContain("opencode v2.0.14");
      const reasons = result.findings.map((finding) => [finding.reason, finding.severity]);
      expect(reasons.filter(([reason]) => String(reason).startsWith("opencode"))).toEqual([
        ["opencode_key_missing", "warning"],
      ]);
      expect(result.findings.find((finding) => finding.reason === "opencode_key_missing")?.detail).toContain(
        "OpenCode runs only its free models",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "says nothing about the key where OPENCODE_API_KEY is set",
    () => {
      const binary = fakeOpenCode("2.1.0");
      const result = preflight({
        agentBinary: binary,
        agentProvider: "opencode-cli",
        reviewerProvider: null,
        needsGh: false,
        needsGit: false,
        env: bare({ OPENCODE_API_KEY: "zen-key-for-test" }),
      });
      expect(result.findings.map((finding) => finding.reason)).not.toContain("opencode_key_missing");
      expect(result.findings.map((finding) => finding.reason)).not.toContain("opencode_too_old");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "refuses an OpenCode 1, whose ACP server the guarantees were not measured on, for the executor and the reviewer",
    () => {
      const binary = fakeOpenCode("1.18.32");
      const executor = preflight({
        agentBinary: binary,
        agentProvider: "opencode-cli",
        reviewerProvider: null,
        needsGh: false,
        needsGit: false,
        env: bare({ OPENCODE_API_KEY: "zen-key-for-test" }),
      });
      expect(executor.ok).toBe(false);
      expect(executor.findings.find((finding) => finding.reason === "opencode_too_old")).toMatchObject({
        severity: "blocking",
        fix: expect.stringContaining("2.0.14"),
      });
      const reviewer = preflight({
        agentBinary: null,
        agentProvider: null,
        reviewerProvider: "opencode-cli",
        needsGh: false,
        needsGit: false,
        env: bare({ OPENCODE_API_KEY: "zen-key-for-test", PERBO_OPENCODE_BINARY: binary }),
      });
      expect(reviewer.findings.map((finding) => finding.reason)).toContain("opencode_too_old");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "names the reviewer's OpenCode when it cannot be run",
    () => {
      const result = preflight({
        agentBinary: null,
        agentProvider: null,
        reviewerProvider: "opencode-cli",
        needsGh: false,
        needsGit: false,
        env: bare({ OPENCODE_API_KEY: "zen-key-for-test" }),
      });
      expect(result.ok).toBe(false);
      expect(result.findings.find((finding) => finding.reason === "reviewer_binary_missing")?.fix).toContain(
        "anomalyco/tap/opencode-v2",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
