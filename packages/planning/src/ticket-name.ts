import { sameName, TICKET_NAME_CAP } from "@perbo/contracts/browser";
import { PlanningError } from "./errors.js";
import { firstSentence } from "./spec-text.js";

/** What a ticket's name is chosen from (D-127). */
export interface TicketNaming {
  /** The name the drafter returned; empty where nothing was drafted. */
  drafted: string;
  /** The title of the spec the ticket was drafted from; empty where there is no spec or it has no title (D-118). */
  specTitle: string;
  /** The contract's outcome, whose first whole sentence names the ticket where nothing before it does. */
  outcome: string;
  /** Every other ticket's name in the store, whatever its state. */
  taken: readonly string[];
  /** The ticket's key, its name where nothing else fits. */
  key: string;
  /** Whether the spec's title is the person's, and the ticket takes it as it stands (`--keep-title`). */
  keepTitle: boolean;
}

/**
 * What a ticket is called (D-127): never more than {@link TICKET_NAME_CAP}
 * characters, and never a cut. `perbo admit` and the desktop's sample host
 * both name a ticket with this, so the sample answers as the host does
 * (D-120).
 *
 * The drafted name first: the fewest words that tell the work apart from every
 * other ticket, which the drafter was shown. Then a spec's own title, what the
 * work was called while its spec was written. Then the outcome's first whole
 * sentence, the only words a typed ticket has to be called by.
 *
 * A candidate another ticket already carries is passed over for the next, and
 * so is one past the cap, whole: a title or a sentence is a person's or a
 * model's words, and only they can say which of them go. Where every
 * candidate is passed over, the first that fits with a number after it that
 * no ticket carries — "Dark mode toggle 2" — names this one, and failing even
 * that the ticket's key does, which is its own and short.
 *
 * With `keepTitle` the spec's title is a name a person gave the work, and the
 * ticket takes it as it stands, whatever was drafted and whatever another
 * ticket is called; one past the cap is refused in {@link keptTitleRefusal}'s
 * words, which the caller asks before any work is done. A spec with no title
 * is named as any other.
 *
 * Display only: the branch and the pull request are named from the outcome,
 * never from this (ADR-0023 §4).
 */
export function ticketName(naming: TicketNaming): string {
  const specTitle = oneLine(naming.specTitle);
  if (naming.keepTitle && specTitle.length > 0) {
    const refusal = keptTitleRefusal(specTitle);
    if (refusal !== null) throw new PlanningError(refusal);
    return specTitle;
  }
  // Flattened because a drafted name is a model's words shown as a title (ADR-0023 §4).
  const fitting = [oneLine(naming.drafted), specTitle, firstSentence(oneLine(naming.outcome))].filter(
    (name) => name.length > 0 && name.length <= TICKET_NAME_CAP,
  );
  const free = (name: string): boolean => !naming.taken.some((taken) => sameName(name, taken));
  const named = fitting.find(free);
  if (named !== undefined) return named;
  for (const name of fitting)
    for (let number = 2; `${name} ${number}`.length <= TICKET_NAME_CAP; number++)
      if (free(`${name} ${number}`)) return `${name} ${number}`;
  return naming.key;
}

/**
 * Why a spec's title cannot be kept as the ticket's name, or null where it
 * can: one past {@link TICKET_NAME_CAP} is refused rather than cut, for the
 * person to shorten, because the name is theirs and only they can say which
 * words go (D-127).
 */
export function keptTitleRefusal(title: string): string | null {
  const kept = oneLine(title);
  return kept.length > TICKET_NAME_CAP
    ? `the spec's title is ${kept.length} characters, and a ticket's name is at most ` +
        `${TICKET_NAME_CAP} (D-127): shorten the title, then draft the plan again`
    : null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
