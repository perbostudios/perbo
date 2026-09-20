import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./usage-error.js";
import type { InspectSubject } from "./inspect.js";
import { TicketlessReviewBundleSchema, type TicketlessReviewBundle } from "./ticketless.js";

/**
 * `<store>/reviews/` — the reviews this store holds that no attempt filed.
 *
 * `perbo review --pr owner/repo#N` and `perbo review --head … --base …` judge
 * a change nobody ran here. There is no attempt, so nothing files the review
 * under a run, and the bundle written into `<store>/reviews/` is the whole
 * record of it. This module is that directory read back — which reviews it
 * holds, and what work each one is about — so that a person can answer one.
 *
 * The work is the plan the reviewer was given and not the review itself:
 * `plan.ticket_id` is minted from the source the contract came from, so two
 * readings of one pull request are two readings of the same change, and a
 * decision taken on either is a decision about that change. It is also the
 * field every reader of `verdicts.json` joins on, which is what lets `--list`
 * find a decision back.
 *
 * Nothing here reads a ticket, and nothing here asks the network: a review in
 * this directory was written by a command that already did both or neither.
 */

const REVIEW_SUFFIX = ".review.json";

/** `<store>/reviews/`, which is where `perbo review` writes and nowhere else. */
export const reviewsDirIn = (storeDirectory: string): string => join(storeDirectory, "reviews");

/** The review ids this store holds a bundle for, in the order it lists them. */
export function recordedReviewIds(storeDirectory: string): string[] {
  const dir = reviewsDirIn(storeDirectory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(REVIEW_SUFFIX))
    .map((name) => name.slice(0, -REVIEW_SUFFIX.length))
    .sort();
}

/**
 * A name that can only be one file of that directory. A reference a person
 * typed reaches this module unchanged, and a name carrying a separator would
 * name a file somewhere else entirely.
 */
const isPlainName = (name: string): boolean => /^[^/\\]+$/.test(name) && name !== "." && name !== "..";

function parseStoredReview(path: string): TicketlessReviewBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = TicketlessReviewBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a readable review:\n  ` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

/**
 * Every review this store holds, oldest first. A file that is not one is
 * stepped over rather than taking the listing with it — the same rule the run
 * records are read by; a review named directly still reports why it would not
 * parse.
 */
export function listStoredReviews(storeDirectory: string): TicketlessReviewBundle[] {
  const dir = reviewsDirIn(storeDirectory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(REVIEW_SUFFIX))
    .flatMap((name) => {
      try {
        return [parseStoredReview(join(dir, name))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Every review filed against one piece of work, oldest first. */
export function storedReviewsFor(storeDirectory: string, ticket_id: string): TicketlessReviewBundle[] {
  return listStoredReviews(storeDirectory).filter((review) => review.plan.ticket_id === ticket_id);
}

/**
 * The review a name is: its own id first, and then the work it judged — which
 * is the id `verdicts.json` carries, so a decision read back can be asked about
 * again. Where the work has been reviewed more than once the newest reading is
 * the one returned; every one of them is about the same change, so what differs
 * is only which findings are on record.
 */
export function findStoredReview(storeDirectory: string, name: string): TicketlessReviewBundle | null {
  if (isPlainName(name)) {
    const path = join(reviewsDirIn(storeDirectory), `${name}${REVIEW_SUFFIX}`);
    if (existsSync(path)) return parseStoredReview(path);
  }
  return storedReviewsFor(storeDirectory, name).at(-1) ?? null;
}

/**
 * The work a stored review is about, in the terms every reader of a decision
 * has. `null` where this store holds no such review.
 *
 * `kind: "local"` because nothing admitted it, exactly as for a run made with
 * no ticket: there is no key, no lifecycle and no admission record, and each
 * reads `null` rather than being filled with something plausible.
 */
export function storedReviewSubject(storeDirectory: string, name: string): InspectSubject | null {
  const review = findStoredReview(storeDirectory, name);
  if (review === null) return null;
  return {
    kind: "local",
    // What a person calls this change: the pull request, where one was named,
    // and otherwise the identity the plan was filed under.
    ticket: review.target.reference ?? review.plan.ticket_id.replace(/^ticket_/, ""),
    ticket_id: review.plan.ticket_id,
    outcome: review.plan.outcome,
    contract_source: review.contract,
    refusal: null,
    state: null,
    pull_request_url: review.target.url,
    // A review of somebody else's change: no run of ours resolved a base for
    // it, so there is none to report.
    base: null,
    // Whoever opened the pull request this read is not on any record here, so
    // there is no answer to give; a ref range has no pull request at all, which
    // is the one case where `false` is the answer rather than the absence of one.
    handed_off: review.target.url === null ? false : null,
    // A stored review is a reading of a change, not of a delivery: nothing here
    // has ever asked GitHub what ran on the head.
    delivery_checks: null,
    admission: null,
    source: null,
    queue: null,
    // Nothing admitted this change, so there is no spec it was drafted from.
    spec_staleness: null,
    runs_started: null,
    // A stored review is about a change, not about a plan with a graph.
    nodes: null,
    edges: null,
    approach_problem: null,
    size: null,
  };
}

/**
 * The refusal for a reference neither the store's own record nor this directory
 * knows, naming both places that were looked in. `unresolved` is what the
 * record said; what is added is what `<store>/reviews/` holds.
 */
export function refuseUnknownReview(storeDirectory: string, reference: string, unresolved: UsageError): never {
  const held = recordedReviewIds(storeDirectory);
  throw new UsageError(
    `${unresolved.message}; and ${reviewsDirIn(storeDirectory)} holds no review '${reference}'` +
      (held.length === 0
        ? ": `perbo review --pr owner/repo#N` writes one there"
        : ` (on record: ${held.join(", ")})`),
  );
}
