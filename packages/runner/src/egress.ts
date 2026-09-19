import type { EgressRecord } from "@perbo/contracts";

/**
 * Egress logging with an attempt-terminating deny path (docs/08, threat 3,
 * launch-blocking item 5).
 *
 * **What this is, exactly.** On the local provider network egress cannot be
 * intercepted — ADR-0004's amendment says so in a table — so this observes the
 * hosts an attempt *asks for*: URLs in the commands it runs and in the tool
 * calls it makes. A host that appears and is not on the allow-list terminates
 * the attempt and raises a security event. A host reached by a process that
 * never named it is not seen.
 *
 * Naming the gap here is better than a log that implies interception it does not do.
 */

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/([A-Za-z0-9._-]+(?::\d+)?)/g;
/**
 * `git clone git@github.com:org/repo` and `scp user@host:path`.
 *
 * The colon and a path after it are **required**. Without them this matches
 * every email address in every tool input — a `CHANGELOG`, a `package.json`
 * author field, `git log` output — and an email address is not a destination.
 * That is the class of false positive; the reserved-TLD list below only covers
 * one instance of it.
 */
const SSH_PATTERN = /\b[A-Za-z0-9._-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(?=[^\s:])/g;

/**
 * Names that cannot be a destination, so they are not egress.
 *
 * RFC 2606 reserves `.test`, `.example` and `.invalid`, and RFC 6761 adds
 * `.localhost`; every one is guaranteed never to resolve on the public
 * internet. Excluding them removes false positives that could never have been
 * true positives, which is why it does not weaken the control.
 *
 * It is here because it fired. Dogfooding this repository on 2026-08-28
 * terminated an attempt on `t.invalid` — a git author email in a test fixture,
 * matched by the `user@host:` pattern that exists to catch
 * `git clone git@github.com:`. An attempt-terminating control that stops on
 * ordinary test data does not get trusted for long, and the fix has to be one
 * that cannot hide a real destination.
 *
 * Two families are deliberately absent because they **do** resolve, and a
 * process talking to them is a thing worth seeing: `.local`, which is mDNS on a
 * LAN, and `localhost` with the loopback literals, which reach a local service.
 * RFC 6761 reserves `.localhost` but also requires it to resolve to loopback,
 * so it is not in the list — a reserved name is only excluded here when it can
 * never resolve at all.
 */
const UNROUTABLE_SUFFIXES = [".test", ".example", ".invalid"] as const;

function couldBeReached(host: string): boolean {
  return !UNROUTABLE_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

export function extractHosts(text: string): string[] {
  const hosts = new Set<string>();
  // Lowercased before the reachability test, not after. Testing first made the
  // two branches disagree — `https://FOO.INVALID/x` was reported and
  // `https://foo.invalid/x` was not, so the exclusion depended on the casing an
  // attacker chose.
  const consider = (raw: string) => {
    const host = raw.toLowerCase();
    if (host.length > 0 && couldBeReached(host)) hosts.add(host);
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    consider((match[1] ?? "").split(":")[0] ?? "");
  }
  for (const match of text.matchAll(SSH_PATTERN)) {
    consider(match[1] ?? "");
  }
  return [...hosts];
}

/** `*.example.com` matches a subdomain; a bare host matches itself only. */
export function hostAllowed(host: string, allowList: readonly string[]): boolean {
  const target = host.toLowerCase();
  return allowList.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === pattern;
  });
}

export class EgressLog {
  private readonly allowList: readonly string[];
  private readonly records: EgressRecord[] = [];
  private readonly seen = new Set<string>();

  constructor(allowList: readonly string[]) {
    this.allowList = allowList;
  }

  /**
   * Record every host named in `text`. Returns the denied ones, which the
   * caller turns into an attempt termination — the log is not advisory.
   */
  observe(text: string, observedIn: string, at: Date): EgressRecord[] {
    const denied: EgressRecord[] = [];
    for (const host of extractHosts(text)) {
      const key = `${host}|${observedIn}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const record: EgressRecord = {
        host,
        decision: hostAllowed(host, this.allowList) ? "allowed" : "denied",
        observed_in: observedIn,
        at: at.toISOString(),
      };
      this.records.push(record);
      if (record.decision === "denied") denied.push(record);
    }
    return denied;
  }

  /** Allowed and denied alike: "every outbound host is logged whether or not". */
  all(): EgressRecord[] {
    return [...this.records];
  }

  denied(): EgressRecord[] {
    return this.records.filter((record) => record.decision === "denied");
  }
}
