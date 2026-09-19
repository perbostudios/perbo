import { describe, expect, it } from "vitest";
import {
  TICKET_STATES,
  TICKET_STATES_REACHABLE,
  TICKET_TRANSITIONS,
} from "../src/ticket.js";

/**
 * `TICKET_STATES_REACHABLE` is a hand-written list of what Stage 3 can actually
 * put a ticket into, and `TICKET_TRANSITIONS` is the graph that decides it.
 * Nothing made them agree, so a transition added or removed could leave the
 * list claiming a state the graph cannot reach, or omitting one it can.
 *
 * That is the same drift the roadmap's corpus count showed three times in two
 * days: two descriptions of one fact, only one of them enforced.
 */

const adjacency = (): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const edge of TICKET_TRANSITIONS) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }
  return out;
};

const reachableFrom = (start: string): Set<string> => {
  const adj = adjacency();
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const state = queue.shift() as string;
    for (const next of adj.get(state) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
};

describe("the ticket lifecycle graph matches what it claims to reach", () => {
  const inbound = new Set(TICKET_TRANSITIONS.map((edge) => edge.to));
  const entries = [...new Set(TICKET_TRANSITIONS.map((edge) => edge.from))].filter(
    (state) => !inbound.has(state),
  );

  it("has exactly one entry state", () => {
    expect(entries).toEqual(["plan_review"]);
  });

  it("reaches every state it declares reachable", () => {
    const reached = reachableFrom("plan_review");
    const missing = TICKET_STATES_REACHABLE.filter((state) => !reached.has(state));
    expect(
      missing,
      "TICKET_STATES_REACHABLE names states the transition graph cannot reach from plan_review. " +
        "Fix the graph or the list, not this test.",
    ).toEqual([]);
  });

  it("declares every state it can reach", () => {
    const reached = [...reachableFrom("plan_review")];
    const undeclared = reached.filter(
      (state) => !(TICKET_STATES_REACHABLE as readonly string[]).includes(state),
    );
    expect(
      undeclared,
      "the graph reaches states TICKET_STATES_REACHABLE does not name, so a ticket can enter a " +
        "state nothing says Stage 3 supports",
    ).toEqual([]);
  });

  it("every transition names states that exist", () => {
    const known = new Set<string>(TICKET_STATES);
    for (const edge of TICKET_TRANSITIONS) {
      expect(known.has(edge.from), `unknown from-state ${edge.from}`).toBe(true);
      expect(known.has(edge.to), `unknown to-state ${edge.to}`).toBe(true);
    }
  });

  it("leaves the unreachable states genuinely unreachable", () => {
    // The enum carries states for milestones whose mechanism does not exist —
    // deployed, observing, rolled_back. If one becomes reachable without being
    // declared, that is a lifecycle nobody designed.
    const reached = reachableFrom("plan_review");
    const notYet = TICKET_STATES.filter(
      (state) => !(TICKET_STATES_REACHABLE as readonly string[]).includes(state),
    );
    for (const state of notYet) {
      expect(reached.has(state), `${state} is reachable but not declared reachable`).toBe(false);
    }
  });
});
