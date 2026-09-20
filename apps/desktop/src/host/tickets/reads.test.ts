import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketReads } from "./reads.js";
import { WorkspaceReads } from "../workspace-reads.js";
import { SettingsSchema } from "../../shared/protocol.js";
import { attemptsPath, bundlesPath, principlesPath, ticketPath } from "../repository/layout.js";
import type { Cli } from "../cli.js";
import type { RepositoryRegistry } from "../repository/registry.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { ProcessResult } from "../process.js";
import type { Repository } from "../../shared/protocol.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const repoId = "80000000-0000-4000-8000-000000000001";
function repository(): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-reads-"));
  temporary.push(root);
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "tickets"), { recursive: true });
  return { id: repoId, name: "checkout", path };
}
const at = "2026-09-19T09:00:00.000Z";
/** A ticket as the store writes one; the schema is strict, so every field is here. */
const ticket = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  ticket_id: "ticket_1",
  key: "PRB-1",
  title: "Make errors actionable",
  state: "ready",
  priority: "normal",
  labels: [],
  depends_on: [],
  source: { kind: "none", reference: null, url: null, title_at_admission: null },
  repository_root: "/checkout",
  plan_id: "plan_00000000000001",
  plan_version: 1,
  approved_at: null,
  admitted_at: at,
  updated_at: at,
  admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 1 },
  delivery: {
    state: "none",
    pull_request_url: null,
    pull_request_number: null,
    observed_at: null,
    branch: null,
  },
  history: [{ at, from: null, to: "ready", note: "Admitted" }],
  ...over,
});
const report = {
  attempts: [],
  total_cost: { micros: 0, partial: 0, unavailable: 0 },
  verdicts: [],
};
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "", cancelled: false });
/** A CLI that answers each command with canned stdout, and records what it was asked. */
function reads(
  answers: Record<string, ProcessResult | (() => ProcessResult)>,
  repo: RegisteredRepository,
  metadataError: string | null = null,
): { tickets: TicketReads; calls: string[] } {
  const calls: string[] = [];
  const cli: Cli = {
    run: (args) => {
      calls.push(args.join(" "));
      const answer = answers[args[0]!];
      if (!answer) throw new Error(`no answer for ${args.join(" ")}`);
      return Promise.resolve(typeof answer === "function" ? answer() : answer);
    },
    spawn: () => {
      throw new Error("not spawned");
    },
  };
  const registry = {
    lookup: () => repo,
    metadata: () =>
      Promise.resolve({
        ...repo,
        branch: "main",
        head: "abc",
        dirty: false,
        configured: false,
        error: metadataError,
      } as Repository),
  } as unknown as RepositoryRegistry;
  return {
    calls,
    tickets: new TicketReads({
      reads: new WorkspaceReads(),
      cli,
      registry,
      settings: () => SettingsSchema.parse({}),
    }),
  };
}
/** Writes a contract beside the ticket, as `perbo admit` does. */
function contract(repo: RegisteredRepository, key = "PRB-1"): string {
  const record = {
    plan_id: "plan_00000000000001",
    version: 1,
    ticket_id: "ticket_1",
    level: "P1",
    outcome: "Make errors actionable",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "The retry button is visible after a failure",
        expected_verification: {
          kind: "test",
          assertion: "The retry button is visible after a failure",
        },
      },
    ],
    nodes: [{ id: "node_1", title: "Show the retry", criteria: ["ac_1"], paths: ["src/**"] }],
    scope: {
      repository_id: "repo_00000000000001",
      paths_allowed: ["src/**"],
      paths_prohibited: [],
      generated_paths: [],
      expansion_budget_files: 3,
    },
    base: {
      base_commit: "a".repeat(40),
      context_manifest_hash: `sha256:${"b".repeat(64)}`,
      captured_at: "2026-09-19T09:00:00.000Z",
    },
  };
  const raw = JSON.stringify(record, null, 2);
  writeFileSync(ticketPath(repo, key, ".contract.json"), raw);
  return createHash("sha256").update(raw).digest("hex");
}

describe("listing a repository's tickets", () => {
  it("runs one listing for the surfaces asking at once", async () => {
    const repo = repository();
    const w = reads({ list: ok(JSON.stringify({ tickets: [ticket()] })) }, repo);
    const [first, second] = await Promise.all([
      w.tickets.list(repo),
      w.tickets.list(repo),
    ]);
    expect(first.tickets[0]?.key).toBe("PRB-1");
    expect(second.tickets).toHaveLength(1);
    expect(w.calls).toEqual(["list --all --json"]);
  });

  it("says a ticket the store no longer holds has gone", async () => {
    const repo = repository();
    const w = reads({ list: ok(JSON.stringify({ tickets: [] })) }, repo);
    await expect(w.tickets.ticket(repo, "PRB-1")).rejects.toThrow(
      "This task is no longer in the repository's ticket store.",
    );
  });

  it("refuses a listing that is not the shape the store promises", async () => {
    const repo = repository();
    const w = reads({ list: ok(JSON.stringify({ tickets: [{ key: "PRB-1" }] })) }, repo);
    await expect(w.tickets.list(repo)).rejects.toThrow();
  });
});

describe("reading the contract", () => {
  it("carries the digest of the bytes it read", () => {
    const repo = repository();
    const digest = contract(repo);
    const read = reads({}, repo).tickets.contract(repo, "PRB-1");
    expect(read.digest).toBe(digest);
    expect(read.contract.outcome).toBe("Make errors actionable");
  });

  it("refuses an approval against a contract that has moved", () => {
    const repo = repository();
    const digest = contract(repo);
    const w = reads({}, repo);
    expect(() => w.tickets.assertDigest(repo, "PRB-1", digest)).not.toThrow();
    expect(() => w.tickets.assertDigest(repo, "PRB-1", "0".repeat(64))).toThrow(
      "The contract changed since you opened it.",
    );
  });
});

describe("the detail one task shows", () => {
  it("reads the ticket, its contract, its report and the repository's principles", async () => {
    const repo = repository();
    contract(repo);
    writeFileSync(principlesPath(repo), "# Principles\n");
    const w = reads(
      {
        list: ok(JSON.stringify({ tickets: [ticket()] })),
        inspect: ok(JSON.stringify(report)),
      },
      repo,
    );
    const detail = await w.tickets.detail(repoId, "PRB-1");
    expect(detail.ticket.key).toBe("PRB-1");
    expect(detail.contract.outcome).toBe("Make errors actionable");
    expect(detail.principles).toBe("# Principles\n");
    expect(detail.attempts).toEqual([]);
    expect(detail.cost).toEqual({ micros: 0, partial: false, unavailable: 0 });
  });

  it("carries the ceilings a run would actually be held to", async () => {
    const repo = repository();
    contract(repo);
    const w = reads(
      { list: ok(JSON.stringify({ tickets: [ticket()] })), inspect: ok(JSON.stringify(report)) },
      repo,
    );
    const settings = SettingsSchema.parse({});
    expect((await w.tickets.detail(repoId, "PRB-1")).effective).toEqual({
      stallMinutes: settings.stallMinutes,
      ticketDollars: settings.ticketDollars,
    });
  });

  it("is read once for the surfaces asking at once, and again after the records move", async () => {
    const repo = repository();
    contract(repo);
    const w = reads(
      { list: ok(JSON.stringify({ tickets: [ticket()] })), inspect: ok(JSON.stringify(report)) },
      repo,
    );
    await Promise.all([w.tickets.detail(repoId, "PRB-1"), w.tickets.detail(repoId, "PRB-1")]);
    expect(w.calls.filter((call) => call.startsWith("inspect"))).toHaveLength(1);
  });
});

describe("the summary a running task shows", () => {
  it("counts the attempts recorded beside the ticket, and the branch they used", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo", "state"), { recursive: true });
    writeFileSync(
      attemptsPath(repo, "ticket_1"),
      JSON.stringify({
        ticket_id: "ticket_1",
        attempts: [
          { attempt_id: "att_1", created_at: at, branch: "prb/1/make-errors-actionable" },
        ],
      }),
    );
    const w = reads({ list: ok(JSON.stringify({ tickets: [ticket()] })) }, repo);
    expect(await w.tickets.summary(repoId, "PRB-1")).toMatchObject({
      attempts: 1,
      branch: "prb/1/make-errors-actionable",
      latestAttemptAt: at,
    });
  });

  it("says why where the attempts record could not be read", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo", "state"), { recursive: true });
    writeFileSync(attemptsPath(repo, "ticket_1"), "{not json");
    const w = reads({ list: ok(JSON.stringify({ tickets: [ticket()] })) }, repo);
    const summary = await w.tickets.summary(repoId, "PRB-1");
    expect(summary.attempts).toBe(0);
    expect(summary.note).toBeTruthy();
  });
});

describe("the bundles a repository sealed", () => {
  it("reads the directory once for every surface that asks", async () => {
    const repo = repository();
    mkdirSync(bundlesPath(repo), { recursive: true });
    writeFileSync(
      join(bundlesPath(repo), "one.json"),
      JSON.stringify({
        bundle_id: "bundle_0000000000000001",
        kind: "execution",
        ticket_id: "ticket_1",
        subject_id: "att_1",
        artifacts: [],
      }),
    );
    const w = reads({}, repo);
    const [first, second] = await Promise.all([w.tickets.bundles(repo), w.tickets.bundles(repo)]);
    expect(first).toHaveLength(1);
    expect(second[0]?.bundle_id).toBe("bundle_0000000000000001");
  });
});

describe("one repository's row on Home", () => {
  it("carries what Git says and the tickets the store holds", async () => {
    const repo = repository();
    const w = reads({ list: ok(JSON.stringify({ tickets: [ticket()] })) }, repo);
    const snapshot = await w.tickets.repositorySnapshot(repoId);
    expect(snapshot.repository.branch).toBe("main");
    expect(snapshot.tasks.map((row) => row.ticket.key)).toEqual(["PRB-1"]);
    expect(snapshot.errors).toEqual([]);
  });

  it("keeps the repository on Home when Git could not read it, with the reason", async () => {
    const repo = repository();
    const w = reads(
      { list: ok(JSON.stringify({ tickets: [ticket()] })) },
      repo,
      "no such file or directory",
    );
    const snapshot = await w.tickets.repositorySnapshot(repoId);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.errors).toEqual(["checkout: Error: no such file or directory"]);
    expect(snapshot.repository.error).toBe("no such file or directory");
  });

  it("keeps the repository on Home when its listing fails, with the reason", async () => {
    const repo = repository();
    const w = reads(
      {
        list: () => ({ code: 2, stdout: "", stderr: "no ticket store here\n", cancelled: false }),
      },
      repo,
    );
    const snapshot = await w.tickets.repositorySnapshot(repoId);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.errors).toEqual(["checkout: Error: no ticket store here"]);
  });
});
