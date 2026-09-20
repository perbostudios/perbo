import {
  TICKET_PRIORITIES,
  matchesAny,
  type Scope,
  type Ticket,
  type TicketState,
  type Wait,
} from "@perbo/contracts";

/**
 * The queue's decisions (SCP-008 criterion 5, SCP-227): which admitted ticket
 * goes first, and which one waits on which.
 *
 * Everything here is set arithmetic over records a person approved — the
 * ticket's `depends_on`, the contract's `paths_allowed`, the paths a sealed
 * branch actually changed — so it costs no model call and cannot be steered by
 * one (ADR-0011: coordination is a typed layer, not a supervising agent). The
 * caller supplies the facts and applies the transitions; nothing here reads a
 * file, a clock or a process.
 */

/** A ticket beside the scope its contract admits, or `null` where no contract is on record. */
export interface Scheduled {
  ticket: Ticket;
  scope: Pick<Scope, "paths_allowed" | "generated_paths"> | null;
}

/**
 * The states in which a ticket holds its place in the queue and its scope
 * against everything behind it: waiting to run, running, and waiting to merge.
 *
 * A settled state holds nothing. `changes_requested`, `failed` and `closed`
 * are a person's to reopen, and a branch nobody is working on is not one a
 * later ticket should wait for; when the person re-runs it, it takes a place
 * again by re-entering `ready`.
 */
export const QUEUE_HOLDING_STATES = [
  "ready",
  "blocked",
  "provisioning",
  "executing",
  "verifying",
  "independent_review",
  "pr_open",
] as const satisfies readonly TicketState[];

/** The states a dependency has to be in for the ticket that names it to be ready. */
export const DEPENDENCY_SATISFIED_STATES = [
  "merged",
  "done",
  "deployed",
  "observing",
] as const satisfies readonly TicketState[];

const holds = (state: TicketState): boolean =>
  (QUEUE_HOLDING_STATES as readonly TicketState[]).includes(state);

const satisfied = (state: TicketState): boolean =>
  (DEPENDENCY_SATISFIED_STATES as readonly TicketState[]).includes(state);

/**
 * Queue order: a ticket's `depends_on` first, and among what is free to go,
 * priority, then admission time, then the key so two tickets admitted in the
 * same millisecond still have one answer.
 *
 * Dependencies outrank priority because the alternative deadlocks: a
 * high-priority ticket that depends on a lower one would hold its place ahead
 * of it, and the lower one would wait on the scope the higher one holds. So
 * the order is the dependency graph walked with the tie-break, and a key the
 * store does not hold, or a cycle a person wrote, is left to `waitsFor` to
 * report rather than resolved here.
 *
 * Admission time rather than approval time, because a person who approves a
 * later ticket first has not said it should go first — they have said it is
 * ready. Priority is theirs to raise where the order should change.
 */
export function queueOrder<T extends Pick<Ticket, "key" | "priority" | "admitted_at" | "depends_on">>(
  tickets: readonly T[],
): T[] {
  const rank = (priority: Ticket["priority"]): number => TICKET_PRIORITIES.indexOf(priority);
  const tieBreak = (a: T, b: T): number =>
    rank(a.priority) - rank(b.priority) || a.admitted_at.localeCompare(b.admitted_at) || a.key.localeCompare(b.key);
  const known = new Set(tickets.map((ticket) => ticket.key));
  const waiting = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const placed = new Set<string>();
  const order: T[] = [];
  while (waiting.size > 0) {
    const free = [...waiting.values()]
      .filter((ticket) => ticket.depends_on.every((key) => !known.has(key) || placed.has(key)))
      .sort(tieBreak);
    // A cycle a person wrote frees nothing; the tie-break alone orders what
    // is left, and each ticket in it waits on the other by `depends_on`.
    const next = free[0] ?? [...waiting.values()].sort(tieBreak)[0]!;
    order.push(next);
    placed.add(next.key);
    waiting.delete(next.key);
  }
  return order;
}

/**
 * The directory a glob names before its first wildcard: the part that names a
 * real place. Cut at a segment boundary, so `src/foo*.ts` names `src/` and
 * not `src/foo` — a partial segment would read `src/foobar.ts` as a sibling
 * rather than as a file the glob admits.
 */
function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?[{]/);
  if (cut === -1) return glob;
  const slash = glob.lastIndexOf("/", cut);
  return slash === -1 ? "" : glob.slice(0, slash + 1);
}

/** `a/b` is inside `a/b/…` and is `a/b` itself; it is not inside `a/bc`. */
function inside(path: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Two scopes overlap where a glob of one names a place inside a glob of the
 * other, decided on the static prefixes the same way `approve` decides a scope
 * against the judging paths (D-045): `packages/**` against `packages/runner/**`
 * overlaps, `packages/run/**` against `packages/runner/**` does not, and a glob
 * with no literal prefix — `**`, or one that starts with it — reaches every place there is.
 *
 * Each pair is reported as the caller's glob beside the other's, so a wait can
 * name what the ticket ahead holds rather than what this one asked for.
 */
export function scopeOverlap(
  mine: readonly string[],
  theirs: readonly string[],
): Array<{ mine: string; theirs: string }> {
  const pairs: Array<{ mine: string; theirs: string }> = [];
  for (const a of mine) {
    const p = staticPrefix(a);
    for (const b of theirs) {
      const q = staticPrefix(b);
      if (p.length === 0 || q.length === 0 || inside(p, q) || inside(q, p)) pairs.push({ mine: a, theirs: b });
    }
  }
  return pairs;
}

/**
 * The sealed paths a scope's globs admit, less the ones either side declares
 * generated.
 *
 * A branch that has sealed is judged by what it changed rather than by what it
 * was allowed to change: globs overlap far more often than diffs do, and the
 * whole point of a second level is to free the ticket whose diff went nowhere
 * near. A lockfile or a codegen output both branches touch is left out — the
 * reconciliation round regenerates it, and waiting on it would serialise every
 * ticket in a repository behind every other.
 */
export function changedPathsOverlap(
  sealed: readonly string[],
  globs: readonly string[],
  exempt: readonly string[],
): string[] {
  return sealed.filter((path) => matchesAny(path, globs) && !matchesAny(path, exempt));
}

/**
 * What one ticket waits on, decided against every ticket in the store.
 *
 * Two kinds of wait, dependencies first:
 *
 * - **`depends_on`**: a key the person wrote on the ticket, until the ticket it
 *   names has merged. A key the store does not hold is a wait with no state to
 *   name, never a wait silently dropped — the person wrote it, so it means
 *   something, and starting anyway would be deciding it did not.
 * - **`scope_overlap`**: a ticket **ahead in the queue order** that holds its
 *   place and whose scope this one's reaches. Ahead, and only ahead: overlap is
 *   symmetric, and deciding it by the order is what makes it an ordering rather
 *   than a deadlock. A ticket ahead that is itself waiting still holds its
 *   place. Once the ticket ahead has sealed, it is judged by the paths it
 *   changed (`sealedPaths`) rather than by its globs; before that, glob against
 *   glob is all there is.
 *
 * `sealedPaths` returns the paths a ticket's branch changed against the base,
 * or `null` where the ticket has not sealed or the caller cannot say. A ticket
 * with no contract on record has no scope to compare and waits on nothing for
 * scope; it still waits on its dependencies.
 */
export function waitsFor(
  candidate: Scheduled,
  all: readonly Scheduled[],
  sealedPaths: (holder: Scheduled) => readonly string[] | null,
): Wait[] {
  const waits: Wait[] = [];
  const byKey = new Map(all.map((entry) => [entry.ticket.key, entry]));

  for (const key of candidate.ticket.depends_on) {
    const dependency = byKey.get(key);
    if (dependency === undefined) {
      waits.push({ key, reason: "depends_on", paths: [], state: null });
    } else if (!satisfied(dependency.ticket.state)) {
      waits.push({ key, reason: "depends_on", paths: [], state: dependency.ticket.state });
    }
  }

  if (candidate.scope === null) return waits;
  const mine = candidate.scope;
  const order = queueOrder(all.map((entry) => entry.ticket)).map((ticket) => ticket.key);
  const myPlace = order.indexOf(candidate.ticket.key);

  const waitedOn = new Set(waits.map((wait) => wait.key));
  for (const holder of all) {
    if (holder.ticket.key === candidate.ticket.key) continue;
    if (!holds(holder.ticket.state)) continue;
    // A dependency already names the wait; a scope line for the same ticket
    // would say the same thing twice.
    if (waitedOn.has(holder.ticket.key)) continue;
    const theirPlace = order.indexOf(holder.ticket.key);
    if (theirPlace === -1 || theirPlace >= myPlace) continue;
    if (holder.scope === null) continue;

    const sealed = sealedPaths(holder);
    const shared =
      sealed === null
        ? [...new Set(scopeOverlap(mine.paths_allowed, holder.scope.paths_allowed).map((pair) => pair.theirs))]
        : changedPathsOverlap(sealed, mine.paths_allowed, [...mine.generated_paths, ...holder.scope.generated_paths]);
    if (shared.length > 0) {
      waits.push({ key: holder.ticket.key, reason: "scope_overlap", paths: shared, state: holder.ticket.state });
    }
  }
  return waits;
}
