import { describe, expect, it } from "vitest";
import { REDACTION, SecretIndex, isSecretPath, secretValuesOf } from "./secrets.js";

describe("secretValuesOf", () => {
  it("takes the right-hand side of an assignment, not the whole line", () => {
    expect(secretValuesOf("STRIPE_KEY=sk_live_51H8xQ2abcdef")).toContain("sk_live_51H8xQ2abcdef");
  });

  it("ignores comments, blanks and short values", () => {
    const values = secretValuesOf("# a comment about SECRET\n\nPORT=5432\nDEBUG=true\n");
    expect(values).toEqual([]);
  });

  it("strips surrounding quotes so the indexed value matches the one in a log", () => {
    expect(secretValuesOf('TOKEN="ghp_abcdefghijklmnop"')).toContain("ghp_abcdefghijklmnop");
  });

  it("indexes long unbroken runs from a key file", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    expect(secretValuesOf(pem)).toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  });
});

describe("SecretIndex", () => {
  const index = new SecretIndex();
  index.add(".env.local", 'DATABASE_URL=postgres://u:p4ssw0rd@localhost/app\nAPI_KEY="sk_live_9f3a2b1c8d7e"\n');

  it("matches by content, not by filename", () => {
    // The same value, in a file with an innocuous name and no `.env` shape.
    const log = "connecting with sk_live_9f3a2b1c8d7e ...";
    expect(index.contains(log)).toBe(true);
    expect(isSecretPath("packages/app/run.log")).toBe(false);
  });

  it("recognises the whole file's bytes wherever they appear", () => {
    const copy = 'DATABASE_URL=postgres://u:p4ssw0rd@localhost/app\nAPI_KEY="sk_live_9f3a2b1c8d7e"\n';
    expect(index.matchesFile(copy)).toBe(true);
  });

  it("redacts every occurrence and reports how many", () => {
    const result = index.redact("a sk_live_9f3a2b1c8d7e b sk_live_9f3a2b1c8d7e");
    expect(result.text).toBe(`a ${REDACTION} b ${REDACTION}`);
    expect(result.redactions).toBe(2);
    expect(result.text).not.toContain("sk_live");
  });

  it("leaves text carrying no indexed value untouched", () => {
    expect(index.contains("nothing to see here")).toBe(false);
    expect(index.redact("nothing to see here").redactions).toBe(0);
  });

  it("keeps plaintext out of the serialisable manifest", () => {
    const serialised = JSON.stringify(index.manifest());
    expect(serialised).toContain(".env.local");
    expect(serialised).not.toContain("sk_live_9f3a2b1c8d7e");
    expect(serialised).not.toContain("p4ssw0rd");
  });

  it("still recognises the secret-shaped path patterns as defence in depth", () => {
    expect(isSecretPath("apps/web/.env.local")).toBe(true);
    expect(isSecretPath("infra/tls/server.pem")).toBe(true);
    expect(isSecretPath("packages/app/src/index.ts")).toBe(false);
  });
});
