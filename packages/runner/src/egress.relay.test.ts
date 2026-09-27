import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { answerAsk, EGRESS_RELAY_DIRECTORY, pendingAsks, relayEgress } from "./egress.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The hook's half of the egress relay (D-NEW-an-unlisted-host-asks), driven
 * with its clock and its sleep in the test's hands: it holds the call until
 * the runner answers, refuses it itself where no answer comes by the deadline
 * — a hook the binary gave up on would let the call run — and refuses a call
 * with no id to hold it under.
 */

const HOST = "googlechromelabs.github.io";
const call = (tool_use_id: string) => ({
  tool_use_id,
  tool: "Bash",
  input: { command: `npx @puppeteer/browsers install chrome@stable --base-url https://${HOST}/chrome` },
});
const relay = { allow_list: ["registry.npmjs.org"], wait_ms: 1_000 };

/** A clock the sleep moves, and what each sleep asked for. */
function clockAndSleep(onSleep: (slept: number) => void = () => undefined) {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      onSleep(sleeps.length);
    },
    sleeps,
  };
}

describe("the hook holding a call for the runner's answer", () => {
  it("refuses the call itself once the wait is over with no answer, and not before", () => {
    const directory = scratch("perbo-relay-");
    const time = clockAndSleep();
    const answer = relayEgress(directory, call("toolu_1"), relay, time.clock, time.sleep);
    expect(answer).toMatchObject({ answer: "refuse", hosts: [HOST] });
    expect(answer?.answer === "refuse" && answer.reason).toMatch(/nobody answered/);
    // Held for the whole wait: the refusal came at the deadline.
    expect(time.clock()).toBeGreaterThanOrEqual(relay.wait_ms);
    expect(time.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(relay.wait_ms);
  });

  for (const given of [{ answer: "allow" as const }, { answer: "refuse" as const, reason: "the network is closed" }]) {
    it(`returns the runner's ${given.answer} once it is written, and asks with the call's id and hosts`, () => {
      const directory = scratch("perbo-relay-");
      const seen = new Set<string>();
      let asked: ReturnType<typeof pendingAsks> = [];
      const time = clockAndSleep((count) => {
        if (count !== 3) return;
        // The runner's half, as the adapter runs it: read the ask and answer it.
        asked = pendingAsks(directory, seen);
        answerAsk(directory, asked[0]!.name, given);
      });
      expect(relayEgress(directory, call("toolu_2"), relay, time.clock, time.sleep)).toEqual({ ...given, hosts: [HOST] });
      expect(asked.map(({ tool_use_id, hosts }) => ({ tool_use_id, hosts }))).toEqual([{ tool_use_id: "toolu_2", hosts: [HOST] }]);
      expect(time.clock()).toBeLessThan(relay.wait_ms);
    });
  }

  it("holds nothing for a call that names no unlisted host", () => {
    const directory = scratch("perbo-relay-");
    const time = clockAndSleep();
    const listed = { ...call("toolu_3"), input: { command: "npm view left-pad --registry https://registry.npmjs.org" } };
    expect(relayEgress(directory, listed, relay, time.clock, time.sleep)).toBeNull();
    expect(time.sleeps).toEqual([]);
  });

  it("refuses a call with no id at once and asks nothing, since every such call would share one answer", () => {
    const directory = scratch("perbo-relay-");
    mkdirSync(join(directory, EGRESS_RELAY_DIRECTORY), { recursive: true });
    // An allow an earlier id-less call was given, under the name every id-less call would share.
    answerAsk(directory, createHash("sha256").update("").digest("hex").slice(0, 32), { answer: "allow" });
    const before = readdirSync(join(directory, EGRESS_RELAY_DIRECTORY));
    const time = clockAndSleep();
    const answer = relayEgress(directory, call(""), relay, time.clock, time.sleep);
    expect(answer).toMatchObject({ answer: "refuse", hosts: [HOST] });
    expect(answer?.answer === "refuse" && answer.reason).toMatch(/carries no id/);
    expect(time.sleeps).toEqual([]);
    expect(readdirSync(join(directory, EGRESS_RELAY_DIRECTORY))).toEqual(before);
  });
});
