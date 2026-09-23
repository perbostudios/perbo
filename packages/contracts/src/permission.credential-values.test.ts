import { describe, expect, it } from "vitest";
import { credentialValuesOf } from "./permission.js";

describe("credentialValuesOf", () => {
  it("takes a value whose name says it authenticates something", () => {
    expect(
      credentialValuesOf({
        GH_TOKEN: "ghp_0123456789abcdefghij",
        ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop",
        DB_PASSWORD: "s3cretpass9",
      }),
    ).toEqual(["ghp_0123456789abcdefghij", "sk-ant-abcdefghijklmnop", "s3cretpass9"]);
  });

  it("leaves a setting alone although its name may not be forwarded to a child", () => {
    // GitHub Actions sets every one of these; the words are ordinary and appear
    // in the output the desktop reads, as `pull_request_url` does.
    expect(
      credentialValuesOf({
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "perbostudios/perbo",
        GITHUB_REF: "refs/pull/9/merge",
        AWS_PROFILE: "production-account",
        GIT_ASKPASS: "/usr/local/bin/askpass",
      }),
    ).toEqual([]);
  });

  it("takes a deny-listed value that carries a credential by its shape", () => {
    expect(
      credentialValuesOf({ ANTHROPIC_BASE_URL: "https://user:s3cretpass9@proxy.example/v1" }),
    ).toEqual(["https://user:s3cretpass9@proxy.example/v1"]);
  });

  it("orders the values longest first, so a prefix leaves no tail", () => {
    expect(
      credentialValuesOf({ SHORT_TOKEN: "abcdefgh", LONG_TOKEN: "abcdefghijkl" }),
    ).toEqual(["abcdefghijkl", "abcdefgh"]);
  });

  it("reads KEY as a credential only where the name ends in it or says API_KEY", () => {
    expect(
      credentialValuesOf({
        SSH_KEY_PATH: "/home/x/.ssh/id_ed25519",
        GPG_KEY_ID: "ABCDEF1234567890",
        STRIPE_KEY: "sk_live_abcdefghij",
        OPENAI_API_KEY_FILE: "/run/secrets/openai",
      }),
    ).toEqual(["/run/secrets/openai", "sk_live_abcdefghij"]);
  });

  it("ignores a value shorter than a credential could be", () => {
    expect(credentialValuesOf({ NPM_TOKEN: "short" })).toEqual([]);
  });
});
