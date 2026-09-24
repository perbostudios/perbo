import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listTickets, readTicket, writeTicket } from "./tickets.js";

/**
 * A ticket file is replaced whole, never rewritten in place.
 *
 * Every reader of the store — `list`, `inspect`, the desktop polling both
 * while a run is live — reads these files while `approve` and `run` rewrite
 * them. A write that truncates and then fills the file hands a reader racing
 * it an empty or half-written ticket, which `listTickets` steps over as
 * unreadable: the ticket vanishes from the store for that one read, and the
 * desktop's page for it says the task is gone.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A store holding one ticket whose history is long enough that writing it takes a while. */
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-store-write-"));
  scratch.push(dir);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  const history = Array.from({ length: 400 }, (_, index) => ({
    at: "2026-08-28T00:00:00.000Z",
    from: index === 0 ? null : "plan_review",
    to: "plan_review",
    note: `step ${index} ${"of the loop recorded at length ".repeat(8)}`,
  }));
  writeFileSync(
    join(dir, "tickets", "RACE-1.json"),
    JSON.stringify({
      schema_version: 1,
      ticket_id: "ticket_race10000",
      key: "RACE-1",
      title: "A ticket rewritten while it is read",
      state: "plan_review",
      priority: "normal",
      labels: [],
      depends_on: [],
      source: { kind: "none", reference: null, url: null, title_at_admission: null },
      plan_id: "plan_01abcdef",
      plan_version: 1,
      approved_at: null,
      admitted_at: "2026-08-28T00:00:00.000Z",
      updated_at: "2026-08-28T00:00:00.000Z",
      admission: { elapsed_ms: 4200, criteria_source: "file", criteria_count: 3 },
      history,
    }),
  );
  return dir;
}

type Tally = { reads: number; torn: number; titles: number };

/**
 * Reads `path` in a loop in a process of its own until `stop` exists: how many
 * reads it made, how many did not parse, and how many different titles it saw.
 * It says how many reads it has made so far in `progress`, so the writer can
 * go on until enough of them have landed rather than for a length of time.
 */
function reader(path: string, stop: string, progress: string): { ready: Promise<void>; done: Promise<Tally> } {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       let reads = 0, torn = 0;
       const titles = new Set();
       process.stdout.write("ready\\n");
       while (!fs.existsSync(${JSON.stringify(stop)})) {
         reads++;
         try { titles.add(JSON.parse(fs.readFileSync(${JSON.stringify(path)}, "utf8")).title); } catch { torn++; }
         if (reads % 25 === 0) fs.writeFileSync(${JSON.stringify(progress)}, String(reads));
       }
       process.stdout.write(JSON.stringify({ reads, torn, titles: titles.size }) + "\\n");`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  let signalReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (signalReady = resolve));
  const done = new Promise<Tally>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.startsWith("ready\n")) signalReady();
    });
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(output.split("\n")[1]!) as Tally));
  });
  return { ready, done };
}

/** How many reads the reader has said it made; nothing yet, or a count caught mid-write, is none. */
const readsSoFar = (progress: string): number => {
  try {
    return Number(readFileSync(progress, "utf8")) || 0;
  } catch {
    return 0;
  }
};

describe("writing a ticket", () => {
  it("is never seen half-written by a reader racing the writer", async () => {
    const dir = store();
    const path = join(dir, "tickets", "RACE-1.json");
    const stop = join(dir, "stop");
    const progress = join(dir, "progress");
    const ticket = readTicket(dir, "RACE-1");
    const racing = reader(path, stop, progress);
    await racing.ready;
    // Bounded by work done, not by time: enough writes and enough reads
    // beside them, with a ceiling for a machine too loaded to get there.
    const cap = Date.now() + 30_000;
    let writes = 0;
    while ((writes < 200 || readsSoFar(progress) < 200) && Date.now() < cap) {
      writeTicket(dir, { ...ticket, title: `A ticket rewritten while it is read, ${writes} times` });
      writes++;
    }
    writeFileSync(stop, "");
    const { reads, torn, titles } = await racing.done;
    // A check nobody can fail is no check: the two have to have overlapped.
    expect(writes).toBeGreaterThanOrEqual(200);
    expect(reads).toBeGreaterThanOrEqual(200);
    expect(titles).toBeGreaterThanOrEqual(2);
    expect(torn).toBe(0);
  }, 60_000);

  it("leaves no temporary behind, and the listing never takes one for a ticket", () => {
    const dir = store();
    const ticket = readTicket(dir, "RACE-1");
    writeTicket(dir, { ...ticket, title: "Written once more" });
    expect(readdirSync(join(dir, "tickets"))).toEqual(["RACE-1.json"]);
    // A write another process has in flight is a temporary beside the file.
    writeFileSync(join(dir, "tickets", "RACE-1.json.4242.0f.tmp"), '{"schema_version": 1, "key": "RA');
    expect(listTickets(dir).map((each) => each.key)).toEqual(["RACE-1"]);
    expect(existsSync(join(dir, "tickets", "RACE-1.json"))).toBe(true);
  });
});
