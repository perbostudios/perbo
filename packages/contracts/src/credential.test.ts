import { describe, expect, it } from "vitest";
import { findCredentials, redactCredentials } from "./credential.js";

const hits = (text: string) => findCredentials(text).map((m) => m.value);

describe("what counts as credential-shaped (D-063, SCP-109)", () => {
  it("finds vendor-prefixed keys", () => {
    expect(hits('const k = "sk_live_51QeXampleNotReal";')).toContain("sk_live_51QeXampleNotReal");
    expect(hits('psk_live_2f9c4ad1NotRealPayoutsKey6b83e7')).toHaveLength(1);
    expect(hits("AKIAIOSFODNN7EXAMPLE")).toHaveLength(1);
    expect(hits("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toHaveLength(1);
  });

  it("finds credentials inlined in a URL", () => {
    expect(hits("postgres://app:hunter2@db.internal:5432/prod")).toEqual([
      "postgres://app:hunter2@db.internal:5432/prod",
    ]);
  });

  it("finds a long literal assigned to a secret-named binding", () => {
    expect(hits('const SIGNING_SECRET = "8Fq2mR7vNc4XwT1bKdE6yHzA";')).toHaveLength(1);
    expect(hits('PAYOUTS_SIGNING_KEY=9d4Tf2xQ1mVb7NcE3sPuG6yH')).toHaveLength(1);
  });

  it("finds a PEM private key block", () => {
    expect(hits("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----")).toHaveLength(1);
  });

  /**
   * The false-positive half. A detector that fires on ordinary code cannot be
   * wired into an artifact writer, because it would mangle findings that are
   * about nothing sensitive.
   */
  it("does not fire on a secret read from the environment", () => {
    expect(hits("const key = process.env.PAYOUTS_SIGNING_KEY;")).toEqual([]);
    expect(hits('signingKey: required("PAYOUTS_SIGNING_KEY")')).toEqual([]);
  });

  it("does not fire on short or obviously-placeholder test values", () => {
    expect(hits('process.env.PAYOUTS_SIGNING_KEY = "test-key";')).toEqual([]);
    expect(hits('const password = "hunter2";')).toEqual([]);
  });

  it("does not fire on hashes, hex digests or identifiers", () => {
    expect(hits('sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"')).toEqual([]);
    expect(hits('id: "550e8400-e29b-41d4-a716-446655440000"')).toEqual([]);
    expect(hits('changeset_id: "cs_01HQ8X9K2M3N4P5Q6R7S8T9V0W"')).toEqual([]);
  });

  it("does not fire on prose that names a variable without a value", () => {
    expect(hits("The comment claims PAYOUTS_SIGNING_KEY_V2 has not been provisioned yet.")).toEqual([]);
  });

  it("redacts the value and keeps the shape a reader needs", () => {
    const out = redactCredentials('const V2 = "sk_live_51QeXampleNotReal";');
    expect(out.text).not.toContain("sk_live_51QeXampleNotReal");
    expect(out.text).toContain("sk_live_");
    expect(out.text).toContain("[redacted");
    expect(out.count).toBe(1);
  });

  it("reports that it fired, because a control that can only pass is not a control", () => {
    expect(redactCredentials("nothing here").count).toBe(0);
    expect(redactCredentials("nothing here").text).toBe("nothing here");
  });
});

describe("the false positives that a corpus sweep actually found", () => {
  /**
   * These are not hypotheticals. Sweeping 282 stored review artifacts — 1.67 MiB
   * of reviewer prose — produced exactly three false positives, all of this
   * shape, written while the reviewer correctly explained that connection
   * strings leak through error messages. Redacting them would have mangled a
   * finding about credential disclosure.
   */
  it("treats user:pass@host as notation, not a credential", () => {
    expect(hits('connect ECONNREFUSED postgres://user:pass@host:5432')).toEqual([]);
    expect(hits("a URL with inline credentials (https://user:pass@host) would leak")).toEqual([]);
    expect(hits("postgres://user:pass@10.0.1.4:5432")).toEqual([]);
    expect(hits("mysql://username:password@db")).toEqual([]);
    expect(hits("https://<user>:<pass>@host")).toEqual([]);
  });

  it("still catches a real credential in the same position", () => {
    expect(hits("postgres://app:hunter2@db.internal:5432/prod")).toEqual([
      "postgres://app:hunter2@db.internal:5432/prod",
    ]);
  });

  it("catches the shapes the first version of this detector missed", () => {
    // Both were declared secrets in the corpus that a randomness requirement
    // excluded: a human-chosen password, and a lowercase-hex vendor token.
    expect(hits("PRICING_DB_PASSWORD=hunter2-pricing-secret")).toEqual(["hunter2-pricing-secret"]);
    expect(hits("MAILER_WEBHOOK_TOKEN=whk_2f7a10c4be6d48f1a0937c5e2db84163")).toHaveLength(1);
  });

  it("does not fire on a config name that merely sounds secret", () => {
    expect(hits('API_KEY_HEADER_NAME = "x-api-key-header"')).toEqual([]);
    expect(hits('TOKEN_COOKIE_NAME = "session_token"')).toEqual([]);
  });
});

/**
 * The prefixes the agents this product runs are authenticated with. A key
 * bound to a secret-named identifier was already found by the binding rule;
 * these are the same keys quoted in prose, which is how a reviewer discloses
 * one while advising rotation and how an agent's own stderr prints one.
 */
describe("the provider key prefixes", () => {
  it("finds an Anthropic key quoted with no binding beside it", () => {
    expect(hits("The key is sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz")).toEqual([
      "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz",
    ]);
  });

  it("finds an OpenAI project key quoted with no binding beside it", () => {
    expect(hits("rotate sk-proj-0123456789abcdefghijklmnop and redeploy")).toEqual([
      "sk-proj-0123456789abcdefghijklmnop",
    ]);
  });

  it("finds a GitHub token shorter than a classic personal access token", () => {
    // A fine-grained or app token is not forty characters, and a rule written
    // to the classic length reads the short ones as ordinary words.
    expect(hits("gh auth said ghp_scp200sentineltokenvalue")).toEqual([
      "ghp_scp200sentineltokenvalue",
    ]);
    expect(hits("ghs_0123456789ab and gho_0123456789ab")).toHaveLength(2);
  });

  it("finds a GitHub token whose tail carries an underscore or a dash", () => {
    // The token's own alphabet. Read as alphanumerics only, a value is found
    // up to its first `_` or `-` and published from there on, or — where the
    // twelfth character is followed by one — not found at all.
    expect(hits("gh auth said ghp_scp200sentinel_token-value")).toEqual([
      "ghp_scp200sentinel_token-value",
    ]);
    expect(hits("gho_0123456789ab-cdef_gh")).toEqual(["gho_0123456789ab-cdef_gh"]);
  });

  it("finds a fine-grained GitHub token whole, the underscore in its middle included", () => {
    // `github_pat_` carries an installation id, an underscore, then the
    // secret. Read as alphanumerics only, the value ends at that underscore
    // and everything after it is published.
    const token = "github_pat_11ABCDEFG0abcdefghijklm_0123456789abcdefghijklmnopqrstuvwxyzAB";

    expect(hits(`gh auth said ${token}`)).toEqual([token]);
    expect(findCredentials(token)[0]?.rule).toBe("vendor.github_pat");
  });

  it("does not fire on a github_pat prefix with too little behind it", () => {
    expect(hits("github_pat_0123456789abcdef")).toEqual([]);
  });

  it("names the rule that fired, so a false positive is attributable", () => {
    expect(findCredentials("sk-ant-api03-0123456789abcdefghij")[0]?.rule).toBe("vendor.anthropic");
    expect(findCredentials("sk-proj-0123456789abcdefghij")[0]?.rule).toBe("vendor.openai_project");
  });

  /**
   * `sk-` on its own is not one of these. `sk-spinner-container` is a class
   * name, and a detector wired into the artifact writer that mangled it would
   * be worse than one that missed a key: the desktop keeps that broader rule
   * for its logs, where a false positive costs a reader nothing.
   */
  it("does not fire on an ordinary identifier that starts sk-", () => {
    expect(hits('<div class="sk-spinner-container sk-fading-circle">')).toEqual([]);
    expect(hits("see docs/sk-onboarding-checklist.md")).toEqual([]);
  });

  it("does not fire on a word that merely starts with a token prefix", () => {
    expect(hits("ghostwriting and ghs_short")).toEqual([]);
  });
});
