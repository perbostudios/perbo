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
