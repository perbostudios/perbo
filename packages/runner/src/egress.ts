import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EgressRecord } from "@perbo/contracts";
import { replaceFile } from "@perbo/workspace";

/**
 * Egress logging, and the question an unlisted host puts to a person (docs/08,
 * threat 3, launch-blocking item 5, D-137).
 *
 * **What this is, exactly.** On the local provider network egress cannot be
 * intercepted — ADR-0004's amendment says so in a table — so this observes the
 * hosts an attempt *asks for*: URLs in the commands it runs and in the tool
 * calls it makes. A host that appears and is not on the allow-list holds the
 * call that named it while a person is asked, where the runner holds that
 * call before it runs, and ends the attempt where nothing holds it. A host
 * reached by a process that never named it is not seen.
 *
 * Naming the gap here is better than a log that implies interception it does not do.
 */

/**
 * The text a tool call is logged and judged by: `Bash` carries a command;
 * everything else is described by its input. The write guard's hook reads the
 * same text before the call runs as the stream reading does after, so the two
 * name the same hosts.
 */
export function describeTool(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof record.command === "string") return record.command;
  if (typeof record.file_path === "string") return `${name} ${record.file_path}`;
  return `${name} ${JSON.stringify(record)}`;
}

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
 * Such names are ordinary test data: a git author email like `a@t.invalid` in
 * a fixture is matched by the `user@host:` pattern that exists to catch
 * `git clone git@github.com:`. A control that stops an attempt or asks a person
 * on ordinary test data does not get trusted for long, and the exclusion has
 * to be one that cannot hide a real destination.
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
  // Lowercased before the reachability test, not after: testing first would
  // make the two branches disagree — `https://FOO.INVALID/x` reported and
  // `https://foo.invalid/x` not — so the exclusion would depend on the casing
  // an attacker chose.
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
  private readonly allowList: string[];
  private readonly records: EgressRecord[] = [];
  private readonly seen = new Set<string>();

  constructor(allowList: readonly string[]) {
    this.allowList = [...allowList];
  }

  /** Whether `host` is on the list as it stands now, a person's allow included. */
  isAllowed(host: string): boolean {
    return hostAllowed(host, this.allowList);
  }

  /** The hosts `text` names that are not on the list as it stands now. */
  unlisted(text: string): string[] {
    return extractHosts(text).filter((host) => !this.isAllowed(host));
  }

  /**
   * Record every host named in `text`. Returns the unlisted ones, recorded
   * `denied` until a person allows them; the caller holds the call that named
   * them for that answer, or ends the attempt where nothing holds it.
   */
  observe(text: string, observedIn: string, at: Date): EgressRecord[] {
    const denied: EgressRecord[] = [];
    for (const host of extractHosts(text)) {
      const key = `${host}|${observedIn}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const record: EgressRecord = {
        host,
        decision: this.isAllowed(host) ? "allowed" : "denied",
        observed_in: observedIn,
        at: at.toISOString(),
      };
      this.records.push(record);
      if (record.decision === "denied") denied.push(record);
    }
    return denied;
  }

  /**
   * A person allowed `host` (D-137): it joins the list
   * for the rest of the attempt, and every record of it so far is allowed,
   * since the call that named it runs once it is.
   */
  allow(host: string): void {
    const target = host.toLowerCase();
    if (!this.isAllowed(target)) this.allowList.push(target);
    for (const [index, record] of this.records.entries())
      if (record.host === target) this.records[index] = { ...record, decision: "allowed" };
  }

  /** Allowed and denied alike: "every outbound host is logged whether or not". */
  all(): EgressRecord[] {
    return [...this.records];
  }

  denied(): EgressRecord[] {
    return this.records.filter((record) => record.decision === "denied");
  }
}

/**
 * The relay between the write guard's hook and the runner, for a call naming
 * an unlisted host (D-137).
 *
 * The hook is a separate process that holds the call before it runs: it writes
 * an ask naming the call and the unlisted hosts into the guard's own
 * directory, and waits for the runner's answer beside it. The runner reads the
 * ask, settles it — asking the person where the run still asks, or answering
 * at once where it does not — and writes the answer. That directory is outside
 * the worktree, so the executor cannot write an answer there: a write to it is
 * a write outside the root, which the same guard refuses (SCP-177).
 *
 * The ask carries the hosts and the call's id and never the command: the
 * runner reads the command from the stream, redacted, as its records keep it.
 */
export const EGRESS_RELAY_DIRECTORY = "egress";

/** What the hook needs to relay a call: the list as the attempt started, and how long it waits. */
export interface EgressRelayState {
  allow_list: string[];
  /** How long the hook holds a call for the runner's answer before it refuses it itself. */
  wait_ms: number;
}

export interface EgressAsk {
  tool_use_id: string;
  hosts: string[];
}

export type EgressRelayAnswer = { answer: "allow" } | { answer: "refuse"; reason: string };

/** The file name one call's ask and answer are kept under: a digest, since the id arrives on stdin. */
function relayName(toolUseId: string): string {
  return createHash("sha256").update(toolUseId).digest("hex").slice(0, 32);
}

const askFile = (directory: string, name: string): string =>
  join(directory, EGRESS_RELAY_DIRECTORY, `${name}.ask.json`);
const answerFile = (directory: string, name: string): string =>
  join(directory, EGRESS_RELAY_DIRECTORY, `${name}.answer.json`);

/** Block this thread for `ms`: the hook is synchronous, and it has nothing else to do. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The hook's half: hold the call until the runner answers, or refuse it where
 * no answer comes within the wait. Null where the call names no unlisted host.
 */
export function relayEgress(
  directory: string,
  call: { tool_use_id: string; tool: string; input: unknown },
  relay: EgressRelayState,
  clock: () => number = Date.now,
  sleep: (ms: number) => void = sleepSync,
): (EgressRelayAnswer & { hosts: string[] }) | null {
  const hosts = extractHosts(describeTool(call.tool, call.input)).filter(
    (host) => !hostAllowed(host, relay.allow_list),
  );
  if (hosts.length === 0) return null;
  // The id names the ask and the answer: calls with no id would share one
  // name, and one could read an answer given for another.
  if (call.tool_use_id.length === 0)
    return {
      hosts,
      answer: "refuse",
      reason:
        `${hosts.join(", ")} is not on this run's network allow-list, and this call carries no id to hold it ` +
        "under while a person is asked, so it is refused. Finish the work without it.",
    };
  const name = relayName(call.tool_use_id);
  mkdirSync(join(directory, EGRESS_RELAY_DIRECTORY), { recursive: true });
  const ask: EgressAsk = { tool_use_id: call.tool_use_id, hosts };
  replaceFile(askFile(directory, name), JSON.stringify(ask));
  const deadline = clock() + relay.wait_ms;
  for (;;) {
    const answer = readAnswer(directory, name);
    if (answer !== null) return { ...answer, hosts };
    if (clock() >= deadline)
      return {
        hosts,
        answer: "refuse",
        reason:
          `${hosts.join(", ")} is not on this run's network allow-list and nobody answered whether to allow ` +
          "it, so the call is refused. Finish the work without it.",
      };
    sleep(50);
  }
}

function readAnswer(directory: string, name: string): EgressRelayAnswer | null {
  const path = answerFile(directory, name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<{ answer: string; reason: string }>;
    if (parsed.answer === "allow") return { answer: "allow" };
    return { answer: "refuse", reason: typeof parsed.reason === "string" ? parsed.reason : "refused" };
  } catch {
    // Replaced whole, so a torn read is not one; an unreadable answer is read again.
    return null;
  }
}

/** The runner's half: every ask not already taken, oldest name first. */
export function pendingAsks(directory: string, taken: Set<string>): Array<EgressAsk & { name: string }> {
  const folder = join(directory, EGRESS_RELAY_DIRECTORY);
  if (!existsSync(folder)) return [];
  const asks: Array<EgressAsk & { name: string }> = [];
  for (const file of readdirSync(folder).sort()) {
    if (!file.endsWith(".ask.json")) continue;
    const name = file.slice(0, -".ask.json".length);
    if (taken.has(name)) continue;
    try {
      const ask = JSON.parse(readFileSync(join(folder, file), "utf8")) as EgressAsk;
      if (typeof ask.tool_use_id !== "string" || !Array.isArray(ask.hosts)) continue;
      taken.add(name);
      asks.push({ name, tool_use_id: ask.tool_use_id, hosts: ask.hosts.filter((host) => typeof host === "string") });
    } catch {
      // Replaced whole by the hook; read again on the next pass.
    }
  }
  return asks;
}

/** The runner's answer to one ask, which the waiting hook reads. */
export function answerAsk(directory: string, name: string, answer: EgressRelayAnswer): void {
  replaceFile(answerFile(directory, name), JSON.stringify(answer));
}

/**
 * How an attempt learns whether an unlisted host may be reached
 * (D-137). The loop hands one to each attempt; the
 * adapter calls it for each unlisted host on a call it holds, and waits.
 */
export type EgressVerdict =
  /** The host is allowed: the held call runs. */
  | { answer: "allow" }
  /** The host is refused: the held call is refused, and the executor is told `tell`. */
  | { answer: "refuse"; tell: string }
  /** Nobody answered within the wait: the attempt ends `unlisted_egress_host`. */
  | { answer: "unanswered"; detail: string };

export interface EgressGate {
  ask(question: {
    host: string;
    /** The whole command that named the host, redacted. */
    command: string;
    /** How long the attempt waits for a person: its stall window. */
    wait_ms: number;
    /** Aborted when the attempt stops for any other reason while it waits. */
    signal: AbortSignal;
  }): Promise<EgressVerdict>;
}
