import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readAttemptsRecord, type AttemptsRecord } from "../../attempts.js";
import { Ledger } from "./ledger.js";
import { attempt } from "./test-support/fakes.js";

const TICKET = "ticket_SCP094";
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledger(prior: AttemptsRecord | null = null): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "perbo-ledger-"));
  scratch.push(dir);
  return new Ledger({ path: join(dir, `${TICKET}.attempts.json`), prior, ticketId: TICKET });
}

const record = (attempts: unknown[]) => ({ attempts }) as unknown as AttemptsRecord;

describe("what a ticket has spent", () => {
  it("leaves a subscription attempt out, because its figure is work and not a bill", () => {
    const run = ledger();
    run.addAttempt(
      attempt({ attempt_id: "att_00000000000000a1", credential_class: "subscription", cost_micros: 900_000 }),
      null,
    );
    run.addAttempt(
      attempt({ attempt_id: "att_00000000000000a2", cost_micros: 100_000 }),
      null,
    );

    expect(run.spend()).toEqual({ micros: 100_000, priced: 1, unpriced: 0 });
  });

  it("counts an unpriced attempt separately and skips one that was never incurred", () => {
    const run = ledger();
    run.addAttempt(
      attempt({ attempt_id: "att_00000000000000a1", cost_basis: "unavailable", cost_micros: 500_000 }),
      null,
    );
    run.addAttempt(
      attempt({ attempt_id: "att_00000000000000a2", cost_basis: "not_incurred", cost_micros: 500_000 }),
      null,
    );

    expect(run.spend()).toEqual({ micros: 0, priced: 0, unpriced: 1 });
  });

  it("counts an attempt it cannot read as unpriced, so a budget cannot fail open", () => {
    expect(ledger(record([{ nothing: true }])).spend()).toEqual({
      micros: 0,
      priced: 0,
      unpriced: 1,
    });
  });

  it("refuses a record whose cost basis it does not know, rather than count it as unpriced", () => {
    const known = attempt({ attempt_id: "att_00000000000000d1", cost_micros: 700_000 });
    const unknown = { ...known, usage: { ...known.usage, cost_basis: "a_basis_from_elsewhere" } };

    expect(() => ledger(record([unknown])).spend()).toThrow(/a_basis_from_elsewhere/);
  });

  it("refuses that record when the ledger is built, before the run spends anything", () => {
    const known = attempt({ attempt_id: "att_00000000000000d2", cost_micros: 700_000 });
    const unknown = { ...known, usage: { ...known.usage, cost_basis: "a_basis_from_elsewhere" } };

    expect(() => ledger(record([unknown]))).toThrow(/att_00000000000000d2.*a_basis_from_elsewhere/);
  });

  it("leaves a subscription attempt's cost basis alone, known or not", () => {
    const known = attempt({
      attempt_id: "att_00000000000000d3",
      credential_class: "subscription",
      cost_micros: 700_000,
    });
    const unknown = { ...known, usage: { ...known.usage, cost_basis: "a_basis_from_elsewhere" } };

    expect(ledger(record([unknown])).spend()).toEqual({ micros: 0, priced: 0, unpriced: 0 });
  });

  it("adds what the ticket's record already holds to what this run has made", () => {
    const run = ledger(record([attempt({ attempt_id: "att_00000000000000b1", cost_micros: 250_000 })]));
    run.addAttempt(attempt({ attempt_id: "att_00000000000000b2", cost_micros: 250_000 }), null);

    expect(run.spend().micros).toBe(500_000);
  });
});

describe("what the run appends to the ticket's record", () => {
  it("appends each attempt once, however many times a park flushed before the end", () => {
    const run = ledger();
    run.addAttempt(attempt({ attempt_id: "att_00000000000000c1" }), null);
    run.flush();
    run.flush();
    run.addAttempt(attempt({ attempt_id: "att_00000000000000c2" }), null);
    const finished = run.finish();

    expect(finished.attempts).toHaveLength(2);
    expect(readAttemptsRecord(run.path)?.attempts.map((entry) => entry.attempt_id)).toEqual([
      "att_00000000000000c1",
      "att_00000000000000c2",
    ]);
  });

  it("puts a park on an attempt still to be written, and refuses one already on disk", () => {
    const run = ledger();
    run.addAttempt(attempt({ attempt_id: "att_00000000000000d1" }), null);
    const wait = {
      reason: "provider_reset" as const,
      started_at: "2026-09-04T00:15:00.000Z",
      until: "2026-09-04T03:30:00.000Z",
      waited_ms: 11_700_000,
      zone: "Europe/London",
      quoted: "resets 4:30am (Europe/London)",
    };
    expect(run.parkAfter("att_00000000000000d1", wait).wait).toEqual(wait);
    run.flush();

    expect(readAttemptsRecord(run.path)?.attempts[0]?.wait).toEqual(wait);
    expect(() => run.parkAfter("att_00000000000000d1", wait)).toThrow(/still to be written/);
  });

  it("names the attempt that sealed a commit, this run's and every earlier one's", () => {
    const run = ledger(
      record([attempt({ attempt_id: "att_00000000000000d1", head_commit: "aaa1111" })]),
    );
    run.addAttempt(attempt({ attempt_id: "att_00000000000000d2", head_commit: "bbb2222" }), "bbb2222");

    expect(run.sealedBy("aaa1111")).toBe("att_00000000000000d1");
    expect(run.sealedBy("bbb2222")).toBe("att_00000000000000d2");
  });

  it("does not claim a commit the attempt carried forward rather than sealed", () => {
    const run = ledger();
    run.addAttempt(attempt({ attempt_id: "att_00000000000000e1", head_commit: "ccc3333" }), null);

    expect(run.sealedBy("ccc3333")).toBeNull();
  });
});
