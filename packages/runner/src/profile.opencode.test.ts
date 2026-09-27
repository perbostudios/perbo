import { describe, expect, it } from "vitest";
import { buildPermissionProfile } from "./profile.js";

describe("the permission profile of an OpenCode executor", () => {
  it("reaches OpenCode Zen and its model catalogue in place of Anthropic's hosts, pinned there", () => {
    const profile = buildPermissionProfile({ worktree: "/w", provider: "opencode-cli", network: ["cdn.example.org"] });
    expect(profile.network_allow_list).toEqual(expect.arrayContaining(["opencode.ai", "models.dev", "github.com", "cdn.example.org"]));
    expect(profile.network_allow_list).not.toContain("api.anthropic.com");
    expect(profile.provider_base_url).toBe("https://opencode.ai/zen/v1");
  });

  it("passes OpenCode Zen's key by name to OpenCode and to no other executor", () => {
    expect(buildPermissionProfile({ worktree: "/w", provider: "opencode-cli" }).env_allow_list).toContain("OPENCODE_API_KEY");
    expect(buildPermissionProfile({ worktree: "/w", provider: "codex-cli" }).env_allow_list).not.toContain("OPENCODE_API_KEY");
    expect(buildPermissionProfile({ worktree: "/w" }).env_allow_list).not.toContain("OPENCODE_API_KEY");
  });
});
