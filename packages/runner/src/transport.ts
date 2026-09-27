/**
 * Reading a model-transport failure out of an agent's own transcript (SCP-172).
 *
 * The adapter never talks to the model provider: the agent process does, and it
 * retries on its own. What the runner sees when those retries are exhausted is
 * an exit code and whatever the agent said on its way out — measured on this
 * repository as ten retries against HTTP 529 `overloaded`, a synthetic
 * assistant message carrying the provider's error, and exit 1 after six minutes
 * with no command run and $0.002 on the meter.
 *
 * That is not the same event as an agent that tried and failed, and recording
 * it as `agent_error` fails a ticket for a minute of API weather. So this
 * module answers one question — *did the transport give up, and was that the
 * last thing that happened?* — and the adapter turns a yes into
 * `transport_unavailable`.
 *
 * ## Giving up, not stumbling
 *
 * A transport that retries says so as it goes: `API Error (529 …) · Retrying
 * in 1 seconds… (attempt 1/10)` is a failure it is *about to* try again, and an
 * agent whose second try worked did not fail on the first. So a report that
 * announces a further attempt is not evidence of exhaustion, and neither is one
 * the agent went on working after — the turns it took afterwards are the
 * transport serving it. What counts is a report with nothing after it: no
 * announced retry, no further turn, and no failure of the agent's own.
 *
 * ## Which statuses count
 *
 * The retry policy is not this module's to invent: it is the one the Anthropic
 * SDK already applies (408 request timeout, 409 conflict, 429 rate limit, and
 * every 5xx — 529 `overloaded` among them), plus the connection-level failures
 * that never reach a status at all. A status outside that set — 400, 401, 403 —
 * is the provider refusing the request rather than being unable to serve it,
 * and no number of further attempts changes it, so it stays an `agent_error`.
 *
 * ## Why the match is anchored
 *
 * An executor reads and writes text all day, and the text of a 529 is a string
 * a repository can contain: a fixture, a test, this very file. Matching it
 * anywhere in a transcript would let a file the agent merely read decide how
 * the attempt terminated, and would hand a prompt-injected repository a way to
 * buy itself a second attempt. So the evidence is only ever taken from where
 * the transport itself speaks — the agent's stderr, the result envelope's
 * `api_error_status`, an `error` event, or an assistant message whose text
 * *begins* with the provider's error — and never from a tool call's input, a
 * file's contents, or the middle of a sentence.
 */

/** A transport failure as the transcript reported it. */
export interface TransportFailure {
  /** The last HTTP status reported, or null for a connection-level failure. */
  status: number | null;
  /** The provider's own error type, where it named one (`overloaded_error`). */
  error_type: string | null;
  /** The transport's error text, as it was written. */
  message: string;
  /** How many retries the agent reported making, where it said. */
  retries: number | null;
  /** The line the failure was read from, so the record can show its source. */
  evidence: string;
}

/**
 * How long the loop waits before the one further attempt.
 *
 * A minute, because the failure being retried is a provider briefly unable to
 * serve rather than a request that is wrong: the observed outage cleared on its
 * own, and an immediate retry would spend the second attempt on the same
 * weather. It is not a backoff schedule, because there is exactly one retry to
 * schedule.
 */
export const TRANSPORT_RETRY_DELAY_MS = 60_000;

/**
 * The Anthropic SDK's own retry rule (`shouldRetry`): request timeout,
 * conflict, rate limit, and any server-side status. Mirrored rather than
 * re-decided, so what the runner calls "the transport would have retried this"
 * is what the transport actually does.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * A failure with no status that a transport retries anyway: the socket, the
 * name resolution, the request that never got an answer.
 */
const CONNECTION_LEVEL =
  /(connection error|connection reset|fetch failed|socket hang up|network error|request timed out|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)/i;

/**
 * `API Error: 529 {...}`, `API Error (529 ...)`, `API Error: Connection error.`
 * — the shapes Claude Code prints, anchored at the start of what the transport
 * wrote.
 */
const API_ERROR = /^API Error[:\s]*\(?\s*(\d{3})?[:\s]*([\s\S]*?)\)?\s*$/;

/** `Retrying in 8 seconds… (attempt 10/10)`, wherever the agent prints it. */
const RETRY_NOTICE = /\(attempt (\d+)\/(\d+)\)/g;

/**
 * The announcement that goes with a retry notice, for a transport that says it
 * is trying again without saying which try this is.
 */
const RETRYING = /\bretrying\b/i;

/** ANSI colour, spelled from its code point so no control byte sits in the source. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Leading decoration on a printed line: box drawing, bullets, indentation. */
const DECORATION = /^[\s─-╿⎿·*>|-]+/;

/**
 * The status behind a provider error type, for a payload that names the type
 * without the status. Anthropic returns each of these types with one status, so
 * a report carrying only the type still says which status it was; a type
 * outside this set is left statusless, which is the honest answer rather than a
 * guess.
 */
const STATUS_FOR_ERROR_TYPE: Readonly<Record<string, number>> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 408,
  request_timeout: 408,
};

/** The `stderr: ` prefix the adapter records a stderr chunk under. */
const STDERR_PREFIX = "stderr: ";

interface Reported {
  status: number | null;
  error_type: string | null;
  message: string;
}

/**
 * The provider's error payload, where the text carries one:
 * `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
 */
function payload(text: string): { error_type: string | null; message: string } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  const record = (typeof error === "object" && error !== null ? error : parsed) as Record<string, unknown>;
  const error_type = typeof record.type === "string" ? record.type : null;
  const message = typeof record.message === "string" ? record.message : "";
  if (error_type === null && message === "") return null;
  return { error_type, message };
}

/** One line of transport speech, parsed into a status, a type and a message. */
function readApiError(text: string): Reported | null {
  const match = API_ERROR.exec(text.replace(ANSI, "").replace(DECORATION, "").trim());
  if (!match) return null;
  const rest = (match[2] ?? "").trim();
  const structured = payload(rest);
  return {
    status: match[1] ? Number(match[1]) : null,
    error_type: structured?.error_type ?? null,
    // The provider's own message where there is one, and the whole remainder
    // otherwise — a transport that wrote prose is quoted as it wrote it.
    message: structured && structured.message !== "" ? structured.message : rest,
  };
}

/** The text blocks of an assistant message, in order. */
function assistantText(event: Record<string, unknown>): string[] {
  const message = (event.message ?? {}) as { content?: Array<{ type?: string; text?: string }> };
  return (message.content ?? [])
    .filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

/** The first non-empty string among an event's candidate fields. */
function firstText(event: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/** The status an envelope states outright, where it states one. */
function envelopeStatus(event: Record<string, unknown>): number | null {
  return typeof event.api_error_status === "number" ? event.api_error_status : null;
}

/** The last `(attempt k/N)` a piece of text carries, where it carries one. */
function retryNotice(text: string): { made: number; allowed: number } | null {
  let last: { made: number; allowed: number } | null = null;
  for (const match of text.matchAll(RETRY_NOTICE)) {
    const made = Number(match[1]);
    const allowed = Number(match[2]);
    if (Number.isFinite(made) && Number.isFinite(allowed)) last = { made, allowed };
  }
  return last;
}

/**
 * Whether the transport, in saying this, said it was going to try again.
 *
 * `(attempt 1/10)` is the first of ten tries and the nine after it are still to
 * come; `(attempt 10/10)` is the last one the agent allows itself, so a failure
 * carrying it is the transport out of road. A retry announced without a count
 * is a retry all the same.
 */
function announcesAnotherTry(text: string): boolean {
  const notice = retryNotice(text);
  if (notice) return notice.made < notice.allowed;
  return RETRYING.test(text);
}

/**
 * What one line of a transcript contributed to the question.
 *
 * `report` is the transport speaking; `worked` is the agent taking a turn,
 * which only happens when the transport served it; `failed` is the agent ending
 * on something that was not the transport at all.
 */
type Signal =
  | { kind: "report"; reported: Reported; evidence: string; announced_another_try: boolean }
  | { kind: "worked" }
  | { kind: "failed" };

/**
 * The transport failure the attempt ended on, or null where it ended on
 * something else.
 *
 * The caller asks this only of an attempt that exited badly, so the question is
 * which of the things the transcript reports was the last — a transport that
 * gave up, a turn the agent went on to take, or a failure of the agent's own.
 * Only the first is a `transport_unavailable`, and only when it did not
 * announce a further try.
 */
export function transportExhaustion(transcript: readonly string[]): TransportFailure | null {
  const signals: Signal[] = [];
  let retries: number | null = null;

  const consider = (reported: Reported | null, from: string) => {
    if (!reported) return false;
    signals.push({
      kind: "report",
      reported,
      evidence: from.trim(),
      announced_another_try: announcesAnotherTry(from),
    });
    return true;
  };

  for (const line of transcript) {
    for (const notice of line.matchAll(RETRY_NOTICE)) {
      const made = Number(notice[1]);
      if (Number.isFinite(made)) retries = Math.max(retries ?? 0, made);
    }

    if (line.startsWith(STDERR_PREFIX)) {
      // Everything the agent process wrote to stderr is its own voice. Prose
      // that is not the transport speaking is neither a report nor a turn: an
      // agent's progress chatter says nothing about the provider either way.
      for (const written of line.slice(STDERR_PREFIX.length).split("\n")) {
        consider(readApiError(written), written);
      }
      continue;
    }

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      // The synthetic message the agent emits in place of a turn it could not
      // take. Anchored: a model that *discusses* a 529 is not reporting one —
      // and a message that reports nothing is a turn the transport served.
      const reported = assistantText(event)
        .map((text) => consider(readApiError(text), text))
        .some(Boolean);
      if (!reported) signals.push({ kind: "worked" });
      continue;
    }

    if (event.type === "user") {
      // A tool result going back to the model: the turn before it completed.
      signals.push({ kind: "worked" });
      continue;
    }

    if (event.type === "error" || event.type === "result") {
      // The result envelope names the status in a field of its own — the
      // reviewer's CLI transport reads the same one — and its text is whatever
      // the agent would otherwise have printed.
      const text = firstText(event, ["result", "error", "message"]);
      const status = envelopeStatus(event);
      const failed = status !== null || event.is_error === true || event.type === "error";
      if (!failed) {
        // A run the agent finished. Its text is the model's own summary, which
        // is not the transport speaking however it opens, and reaching the end
        // is proof the transport was serving.
        signals.push({ kind: "worked" });
        continue;
      }
      const reported = readApiError(text);
      if (reported) {
        consider({ ...reported, status: reported.status ?? status }, text);
        continue;
      }
      // An event that carries the provider's payload as a field rather than as
      // a printed line: `{"type":"error","error":{"type":"overloaded_error"}}`.
      // Read from that field alone, never from the event around it, so an
      // envelope's own `type` cannot be mistaken for the provider's.
      const nested = event.error;
      const structured =
        payload(text) ??
        (typeof nested === "object" && nested !== null ? payload(JSON.stringify({ error: nested })) : null);
      if (structured) consider({ status, ...structured }, text === "" ? line : text);
      else if (status !== null) consider({ status, error_type: null, message: text }, text === "" ? line : text);
      // A failure the agent stated in its own words, with no transport in it:
      // that, and not an earlier blip, is what the attempt ended on. An
      // envelope that states no reason at all supersedes nothing — it is the
      // exit code again, which is what the caller already knows.
      else if (text.trim() !== "") signals.push({ kind: "failed" });
    }
  }

  const last = signals[signals.length - 1];
  if (last === undefined || last.kind !== "report" || last.announced_another_try) return null;
  const status = last.reported.status ?? STATUS_FOR_ERROR_TYPE[last.reported.error_type ?? ""] ?? null;
  if (status === null && !CONNECTION_LEVEL.test(last.reported.message)) return null;
  if (status !== null && !isRetryableStatus(status)) return null;
  return {
    status,
    error_type: last.reported.error_type,
    message: last.reported.message,
    retries,
    evidence: last.evidence,
  };
}

/**
 * The failure as `termination.detail` states it: the last status and the
 * transport's own error text, so the record says which weather it was rather
 * than that something went wrong.
 */
export function describeTransportFailure(
  failure: TransportFailure,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): string {
  const status = failure.status === null ? "no HTTP status" : `HTTP ${failure.status}`;
  const named = failure.error_type ? ` ${failure.error_type}` : "";
  const text = failure.message.trim() === "" ? "no error text" : failure.message.trim();
  const tried = failure.retries === null ? "" : ` after ${failure.retries} reported retries`;
  const ended = exit.code ?? exit.signal ?? "unknown";
  return (
    `the model transport was unavailable${tried}: ${status}${named} — ${text}. ` +
    `The agent exited ${ended} rather than finishing the work.`
  );
}

/**
 * A provider that said when it will serve again (SCP-193).
 *
 * `429 … You've hit your session limit · resets 4:30am (Europe/London)` is not
 * the same event as an overloaded transport. The 529 clears on its own in a
 * minute; a session limit clears at a stated time, and a run that retries
 * before it meets the same refusal and spends an attempt on it. So the reset is
 * read out of what the transport wrote, turned into an instant, and the loop
 * waits for it.
 *
 * The time is a **wall clock in a named zone**, and the instant it stands for
 * is what gets recorded — a record that kept `4:30am` would be re-read against
 * whatever zone the reader is in.
 */
export interface ProviderReset {
  /** The instant the provider said it would serve again. */
  until: Date;
  /** The IANA zone the time was read in. */
  zone: string;
  /** Whether the provider named that zone, or this is the machine's own. */
  zone_source: "stated" | "machine";
  /** The provider's own words, as far as the sentence that carried the time. */
  quoted: string;
}

/**
 * `resets 4:30am (Europe/London)`, `resets at 16:05`, `resets 4am` — the shapes
 * the reset is written in. The hour is required; the minutes and the meridiem
 * are not, because `resets 4am` and `resets 16:05` are both written.
 */
const RESET = /\bresets?\b\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i;

/** `(Europe/London)`, `(UTC)` — a zone the provider named beside the time. */
const RESET_ZONE = /\(\s*(UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)\s*\)/;

/** The sentence the reset was written in, for the record to quote. */
const RESET_SENTENCE = /[^.\n·|]*\bresets?\b[^.\n]*/i;

/** Whether `Intl` knows this zone, asked rather than assumed. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * How far `zone` is from UTC at one instant, in milliseconds.
 *
 * Read from `Intl` rather than from a table: the offset moves with daylight
 * saving, and a reset at 4:30am on the morning the clocks go forward is exactly
 * the case a fixed offset gets wrong.
 */
function offsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return asUtc - at;
}

/** The calendar date `zone` is on at one instant. */
function dateIn(zone: string, at: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: field("year"), month: field("month"), day: field("day") };
}

/**
 * The next instant at which `zone`'s wall clock reads `hour:minute`.
 *
 * Today's occurrence where it is still ahead, tomorrow's otherwise: a limit
 * that resets at 4:30am, read at 2am, means this morning, and read at 5am it
 * means tomorrow. The offset is resolved twice because the first guess is made
 * in UTC and a zone's offset depends on the instant — which is the difference a
 * daylight-saving boundary between the two makes.
 */
function nextWallClock(zone: string, hour: number, minute: number, now: number): number | null {
  const today = dateIn(zone, now);
  for (const ahead of [0, 1, 2]) {
    const wall = Date.UTC(today.year, today.month - 1, today.day + ahead, hour, minute);
    const settled = wall - offsetMs(zone, wall - offsetMs(zone, wall));
    if (settled > now) return settled;
  }
  return null;
}

/**
 * The reset a transport failure named, or null where it named none.
 *
 * Read from the failure's own text — the message the transport wrote and the
 * line it was read from — and from nothing else, so the anchoring
 * `transportExhaustion` already applies to what a repository can say carries
 * here too: a file that contains the words "resets 4:30am" is not a provider.
 */
export function providerReset(failure: TransportFailure, now: Date): ProviderReset | null {
  for (const text of [failure.message, failure.evidence]) {
    const found = resetInText(text, now);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The same reading, of one piece of transport speech.
 *
 * The loop reads the sentence `describeTransportFailure` already wrote onto the
 * termination — which is built from an anchored `transportExhaustion` and from
 * nothing else — so the reset it acts on has the same provenance as the
 * termination reason it acts on it for.
 */
export function resetInText(text: string, now: Date): ProviderReset | null {
  {
    const match = RESET.exec(text);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase().replace(/\./g, "") ?? null;
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour < 12) hour += 12;
    // With no meridiem the hour is read as written, so a 24-hour clock works;
    // anything above 23 is not a time at all.
    if (hour > 23) return null;
    const stated = RESET_ZONE.exec(text)?.[1] ?? null;
    const named = stated !== null && knownZone(stated);
    const zone = named ? stated! : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const until = nextWallClock(zone, hour, minute, now.getTime());
    if (until === null) return null;
    return {
      until: new Date(until),
      zone,
      zone_source: named ? "stated" : "machine",
      quoted: (RESET_SENTENCE.exec(text)?.[0] ?? text).trim(),
    };
  }
}
