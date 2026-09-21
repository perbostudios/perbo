import { createHash } from "node:crypto";
import { matchesAny } from "./paths.js";

/**
 * Materialized local secrets never leave the machine (D-012, ADR-0025 §2).
 *
 * The load-bearing word is **content**. Excluding `.env` by name protects a
 * file called `.env` and nothing else: the same bytes copied into a log line, a
 * commit message, a test fixture or a transcript are the same disclosure under
 * a different filename. So materialization builds an index of what it copied,
 * and every artefact that could leave the machine is filtered against that
 * index. The filename patterns stay as defence in depth, not as the mechanism.
 */

/** Kept as a second line, never as the mechanism. */
export const SECRET_PATH_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/secrets/**",
  "**/.npmrc",
  "**/.netrc",
] as const;

export function isSecretPath(path: string): boolean {
  return matchesAny(path, SECRET_PATH_PATTERNS);
}

export const REDACTION = "[redacted: materialized local secret]";

/**
 * Below this length a "secret" is a word. Matching shorter runs would redact
 * `true`, `5432` and `local` out of every artifact and make the record useless,
 * which is its own kind of data loss.
 */
export const MIN_SECRET_VALUE_LENGTH = 12;

const sha256 = (value: string | Buffer) =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

/**
 * Values worth indexing from one materialized file.
 *
 * `KEY=VALUE` lines give the value; everything else contributes whole lines and
 * long unbroken runs, which is what a PEM block or a token file looks like.
 */
export function secretValuesOf(content: string): string[] {
  const values = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    if (assignment) {
      const value = (assignment[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value.length >= MIN_SECRET_VALUE_LENGTH) values.add(value);
      continue;
    }
    if (line.length >= MIN_SECRET_VALUE_LENGTH) values.add(line);
    for (const run of line.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []) values.add(run);
  }
  return [...values];
}

/**
 * Replace every value in `text` with `marker`, longest first.
 *
 * The order is the whole point: a value that is a prefix of another one, put
 * back first, consumes the prefix and leaves the longer value's tail standing
 * in the text — which is the half of a credential that is still a credential.
 */
export function replaceValues(
  text: string,
  values: readonly string[],
  marker: string,
): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length === 0) continue;
    let index = out.indexOf(value);
    while (index !== -1) {
      out = out.slice(0, index) + marker + out.slice(index + value.length);
      count += 1;
      index = out.indexOf(value, index + marker.length);
    }
  }
  return { text: out, count };
}

export interface SecretIndexEntry {
  /** Where it was materialized. Recorded so a report can name the file, not its bytes. */
  path: string;
  /** sha256 of the whole file, which catches a verbatim copy under any name. */
  content_sha256: string;
  /** sha256 of each candidate value, which catches one line pasted into a log. */
  value_sha256: string[];
}

export class SecretIndex {
  private readonly fileHashes = new Set<string>();
  private readonly valueHashes = new Set<string>();
  private readonly byHash = new Map<string, string>();
  readonly entries: SecretIndexEntry[] = [];

  /** Index one materialized file. The plaintext is never retained. */
  add(path: string, content: Buffer | string): SecretIndexEntry {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const contentHash = sha256(buffer);
    const values = secretValuesOf(buffer.toString("utf8"));
    const valueHashes: string[] = [];
    for (const value of values) {
      const hash = sha256(value);
      valueHashes.push(hash);
      this.valueHashes.add(hash);
      this.byHash.set(hash, value);
    }
    this.fileHashes.add(contentHash);
    const entry = { path, content_sha256: contentHash, value_sha256: valueHashes };
    this.entries.push(entry);
    return entry;
  }

  get size(): number {
    return this.valueHashes.size;
  }

  /** True when these exact bytes are a file that was materialized. */
  matchesFile(content: Buffer | string): boolean {
    return this.fileHashes.has(sha256(content));
  }

  /**
   * True when the text carries an indexed value anywhere inside it. This is the
   * check that runs before anything is written to a bundle, a log or a diff.
   */
  contains(text: string): boolean {
    if (this.matchesFile(text)) return true;
    for (const value of this.byHash.values()) {
      if (text.includes(value)) return true;
    }
    return false;
  }

  /** Replace every indexed value. */
  redact(text: string): { text: string; redactions: number } {
    const replaced = replaceValues(text, [...this.byHash.values()], REDACTION);
    return { text: replaced.text, redactions: replaced.count };
  }

  /** The serialisable half: hashes and paths, never plaintext. */
  manifest(): SecretIndexEntry[] {
    return this.entries.map((entry) => ({ ...entry, value_sha256: [...entry.value_sha256] }));
  }
}
