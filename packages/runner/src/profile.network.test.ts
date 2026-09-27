import { describe, expect, it } from "vitest";
import { buildPermissionProfile, DEFAULT_NETWORK_ALLOW_LIST } from "./profile.js";
import { TicketRunConfigSchema } from "./loop/index.js";

/**
 * The hosts a repository adds to the executor's egress allow-list: read from
 * the run configuration, validated there, and merged with the provider's own
 * defaults into the profile every attempt of the run is given.
 */

const base = {
  ticket_key: "PRB-1",
  repository_root: "/repo",
  worktree_root: "/worktrees",
  bundle_root: "/bundles",
  quarantine_root: "/quarantine",
  state_root: "/state",
};

describe("a repository's network_allow_list", () => {
  it("reaches the profile beside every default host", () => {
    const config = TicketRunConfigSchema.parse({
      ...base,
      network_allow_list: ["googlechromelabs.github.io"],
    });
    const profile = buildPermissionProfile({ worktree: "/w", network: config.network_allow_list });
    expect(profile.network_allow_list).toEqual([...DEFAULT_NETWORK_ALLOW_LIST, "googlechromelabs.github.io"]);
  });

  it("extends Codex's hosts rather than replacing them", () => {
    const profile = buildPermissionProfile({
      worktree: "/w",
      provider: "codex-cli",
      network: ["googlechromelabs.github.io"],
    });
    expect(profile.network_allow_list).toContain("chatgpt.com");
    expect(profile.network_allow_list).toContain("registry.npmjs.org");
    expect(profile.network_allow_list).toContain("googlechromelabs.github.io");
    expect(profile.network_allow_list).not.toContain("api.anthropic.com");
  });

  it("leaves the defaults alone where the repository adds nothing", () => {
    const config = TicketRunConfigSchema.parse(base);
    expect(config.network_allow_list).toEqual([]);
    expect(buildPermissionProfile({ worktree: "/w", network: config.network_allow_list }).network_allow_list).toEqual([
      ...DEFAULT_NETWORK_ALLOW_LIST,
    ]);
  });

  it("holds a default the repository names again once", () => {
    const profile = buildPermissionProfile({ worktree: "/w", network: ["github.com"] });
    expect(profile.network_allow_list.filter((host) => host === "github.com")).toHaveLength(1);
  });

  it.each([
    "*.github.io",
    "https://googlechromelabs.github.io",
    "googlechromelabs.github.io/chrome-for-testing",
    "googlechromelabs.github.io:443",
    "googlechromelabs .github.io",
    "",
    ".github.io",
    "github.io.",
    "-bad.github.io",
  ])("refuses %j by name", (entry) => {
    const parsed = TicketRunConfigSchema.safeParse({
      ...base,
      network_allow_list: ["registry.example.org", entry],
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues.find((candidate) => candidate.path[0] === "network_allow_list");
    expect(issue?.path).toEqual(["network_allow_list", 1]);
    expect(issue?.message).toContain(`${JSON.stringify(entry)} is not a host name`);
  });

  it("admits a single-label host and an upper-case one as written", () => {
    const config = TicketRunConfigSchema.parse({ ...base, network_allow_list: ["mirror", "Mirror.Example.ORG"] });
    expect(config.network_allow_list).toEqual(["mirror", "Mirror.Example.ORG"]);
  });

  it("refuses a list that is not a list", () => {
    expect(TicketRunConfigSchema.safeParse({ ...base, network_allow_list: "googlechromelabs.github.io" }).success).toBe(
      false,
    );
  });
});
