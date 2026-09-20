/**
 * What counts as credential-shaped (D-063, SCP-109).
 *
 * The measured problem this answers: a reviewer that reports a committed
 * credential correctly **discloses it in the process** — quoting the line that
 * violates a criterion, or naming a key while advising rotation. Twelve reviews
 * over the four secret-bearing fixtures leaked 6 of 6 on the channels where
 * nothing but the model's judgement protects the value, and 0 of 6 where a
 * mechanism does. The conclusion drawn there was that the mechanism is what
 * works, so this is the mechanism's definition.
 *
 * It is deliberately **narrow**. A detector wired into the artifact writer is
 * destructive: every false positive mangles a finding about something that was
 * never sensitive, and a reviewer whose statements are full of `[redacted]`
 * where it discussed ordinary code is worse than one that occasionally quotes a
 * key. So each rule below requires a positive signal of secrecy — a vendor
 * prefix, credentials inside a URL, a PEM header, or a *long, high-variety*
 * literal bound to a secret-named identifier — rather than firing on entropy
 * alone. Hashes, UUIDs, ULIDs and hex digests are common in ordinary code and
 * are excluded explicitly.
 *
 * The false-positive behaviour is not asserted here; it is measured across the
 * whole corpus. A rule that fires on ordinary fixture code is a rule that does
 * not ship.
 */

export interface CredentialMatch {
  value: string;
  /** Which rule fired, so a false positive is attributable to a rule rather than to "the detector". */
  rule: string;
  index: number;
}

/** Vendor-issued key formats. The prefix is the signal; length is a guard. */
const VENDOR_PREFIXES = [
  { rule: "vendor.stripe_like", pattern: /\b[a-z]{0,4}(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g },
  { rule: "vendor.github", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { rule: "vendor.github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { rule: "vendor.aws_access_key", pattern: /\bAKIA[0-9A-Z]{12,20}\b/g },
  { rule: "vendor.google_api", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { rule: "vendor.slack", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { rule: "vendor.mailer_like", pattern: /\b[a-z]{2,5}_live_[A-Za-z0-9]{12,}\b/g },
];

/** A credential inside a URL authority — scheme://user:password@host */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/?#@'"]+):([^\s:/?#@'"]+)@[^\s/?#'"]+[^\s'"`,)]*/g;

/**
 * Words that are notation rather than credentials. Measured, not guessed: a
 * sweep of 282 review artifacts found the detector's only false positives were
 * `postgres://user:pass@host` and friends, written by the reviewer while
 * correctly explaining that connection strings leak through error messages.
 * Redacting those would mangle the finding — the irony being that the finding
 * was about credential disclosure.
 */
const PLACEHOLDER = /^(?:user|username|pass|passwd|password|secret|token|key|xxx+|\*+|<[^>]*>|foo|bar|example|changeme|redacted)$/i;

/** A PEM private key block, header through footer. */
const PEM_BLOCK = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]{0,4096}?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;

/** A JWT: three base64url segments, the first decoding to a JSON header. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * A long literal bound to a secret-named identifier. The binding is the signal:
 * `SIGNING_SECRET = "<24 chars>"` is a credential, `sha256 = "<64 hex>"` is not,
 * which is why the digest exclusions below are applied to the captured value.
 */
const SECRET_BINDING =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|SIGNING_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*["'`]?([A-Za-z0-9+/_-]{16,})["'`]?/gi;

/**
 * Values that are common in ordinary code and are never treated as secrets,
 * even when bound to a secret-named identifier. A digest stored in
 * `PASSWORD_HASH` is a hash, not a password.
 */
const NOT_A_SECRET = [
  { rule: "hex_digest", test: (v: string) => /^[0-9a-f]{32,}$/i.test(v) },
  {
    rule: "uuid",
    test: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  },
  { rule: "ulid_or_prefixed_id", test: (v: string) => /^[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{20,}$/.test(v) },
];

/**
 * Mixed case and digits. A machine-issued key looks like this; a config name
 * such as `x-api-key-header` does not.
 */
function looksRandom(value: string): boolean {
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  return [hasLower, hasUpper, hasDigit].filter(Boolean).length >= 3;
}

/**
 * How long a value bound to a secret-named identifier has to be before it
 * counts. Randomness is **not** required — the first version of this detector
 * demanded it and consequently missed both `hunter2-pricing-secret` and a
 * lowercase-hex webhook token, which are exactly the shapes a human-chosen
 * password and a vendor token take. The identifier is the signal; length is
 * what separates a credential from a config name like `x-api-key-header`.
 */
const MIN_RANDOM = 16;
const MIN_PLAIN = 20;

export function findCredentials(text: string): CredentialMatch[] {
  const found: CredentialMatch[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) =>
    claimed.some(([a, b]) => start < b && end > a);
  const push = (value: string, rule: string, index: number) => {
    if (overlaps(index, index + value.length)) return;
    claimed.push([index, index + value.length]);
    found.push({ value, rule, index });
  };

  for (const match of text.matchAll(URL_CREDENTIAL)) {
    if (match.index === undefined) continue;
    // `user:pass@host` is how people write a URL shape, not a credential.
    if (PLACEHOLDER.test(match[1] ?? "") && PLACEHOLDER.test(match[2] ?? "")) continue;
    push(match[0], "url_credential", match.index);
  }

  for (const { rule, pattern } of [
    { rule: "pem_private_key", pattern: PEM_BLOCK },
    { rule: "jwt", pattern: JWT },
    ...VENDOR_PREFIXES,
  ]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) push(match[0], rule, match.index);
    }
  }

  for (const match of text.matchAll(SECRET_BINDING)) {
    const value = match[1];
    if (value === undefined || match.index === undefined) continue;
    if (NOT_A_SECRET.some((rule) => rule.test(value))) continue;
    if (value.length < (looksRandom(value) ? MIN_RANDOM : MIN_PLAIN)) continue;
    push(value, "secret_binding", match.index + match[0].indexOf(value));
  }

  return found.sort((a, b) => a.index - b.index);
}

export interface Redaction {
  text: string;
  count: number;
  rules: string[];
}

/**
 * Replaces each credential with a marker that keeps what a reader legitimately
 * needs — the vendor prefix, so "a Stripe live key is committed here" survives —
 * and removes the part that authenticates. `count` is the point: a control that
 * can only pass is not a control, so the corpus measures that redaction *fired*
 * rather than that a secret is absent.
 */
export function redactCredentials(text: string): Redaction {
  const matches = findCredentials(text);
  if (matches.length === 0) return { text, count: 0, rules: [] };

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    const prefix = /^([a-z_]{0,12}_(?:live|test)_)/i.exec(match.value)?.[1] ?? "";
    out += text.slice(cursor, match.index);
    out += `${prefix}[redacted:${match.rule}]`;
    cursor = match.index + match.value.length;
  }
  out += text.slice(cursor);
  return { text: out, count: matches.length, rules: [...new Set(matches.map((m) => m.rule))] };
}
