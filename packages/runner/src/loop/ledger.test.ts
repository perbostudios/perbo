import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readAttemptsRecord, type AttemptsRecord } from "../attempts.js";
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
