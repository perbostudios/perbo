export type ProviderErrorKind = "provider_unavailable" | "budget_exhausted" | "timeout";

/** How much of a transport's own error text a review record may carry. */
const MAX_FAILURE_TEXT = 300;

/**
 * Node names the argument it refused by quoting it — `… must be a string
 * without null bytes. Received '<perbo:repo_file …'`. The sentence before it
 * says what went wrong; the quotation is the value itself, and goes.
 */
const RECEIVED = /\s*Received\b[\s\S]*$/;

/**
 * A transport failure as a review record is allowed to state it.
 *
 * `errors[].message` is written into the run bundle and read by a person, and
 * until SCP-188 it could be the whole prompt: AYO-33's bundle carried the
 * contents of `packages/contracts/src/verdicts.ts`, because the prompt was a
 * command-line argument and Node quoted the argument it refused. Nothing the
 * transport handed the process is quoted back here — the quotation is dropped,
 * what remains is one bounded line, and a line that still opens with text that
 * was sent is withheld entirely.
 *
 * An error *about a file* is not this: the reader's refusals name the path and
 * the reason and never carry the bytes, and they reach the model as a read
 * result rather than as a transport failure.
 *
 * @param raw the transport's own error text
 * @param sent every string this turn handed the process
 */
export function providerFailureText(raw: string, sent: readonly string[]): string {
  const first = (raw.split("\n", 1)[0] ?? "").replace(RECEIVED, "").trim();
  if (first === "") return "no error text";
  const bounded =
    first.length > MAX_FAILURE_TEXT ? `${first.slice(0, MAX_FAILURE_TEXT)}…` : first;
  return quotesSentText(bounded, sent)
    ? "the transport quoted what it was sent, and it was withheld"
    : bounded;
}

function quotesSentText(text: string, sent: readonly string[]): boolean {
  return sent.some((value) => {
    // A control byte is written as an escape wherever it is quoted, so the
    // probe is the printable opening of what was sent rather than all of it.
    const probe = (/^[^\p{Cc}]*/u.exec(value)?.[0] ?? "").slice(0, 40);
    return probe.length >= 12 && text.includes(probe);
  });
}

export class ProviderError extends Error {
  readonly attempts: number;
  readonly kind: ProviderErrorKind;

  constructor(message: string, attempts: number, kind: ProviderErrorKind = "provider_unavailable") {
    super(message);
    this.name = "ProviderError";
    this.attempts = attempts;
    this.kind = kind;
  }
}
