import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { pullRequestUrl, ticketWorktree, type TicketRecords } from "./open.js";
import { attemptsPath } from "../repository/layout.js";
import type { Execute } from "../repository/git.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Ticket } from "@perbo/contracts";
import type { Detail } from "../../shared/protocol.js";

const scratchDirectory = createScratch("perbo-open-");
afterEach(() => {
  scratchDirectory.removeAll();
});
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  mkdirSync(join(root, "checkout"), { recursive: true });
  // The host registers a canonical path, and refusing its own checkout is a comparison against it.
  return {
    id: "80000000-0000-4000-8000-000000000001",
    name: "checkout",
    path: realpathSync(join(root, "checkout")),
  };
}
const contract = {
  schema_version: 1,
  plan_id: "plan_1",
  ticket_id: "ticket_1",
  outcome: "Make errors actionable",
} as unknown as ReturnType<TicketRecords["contract"]>["contract"];
const ticket = {
  key: "PRB-1",
  ticket_id: "ticket_1",
  delivery: { branch: null, pull_request_url: null },
} as unknown as Ticket;
function records(over: Partial<Ticket> = {}): TicketRecords {
  return {
    list: () => Promise.resolve({ tickets: [{ ...ticket, ...over } as Ticket] }),
    contract: () => ({ contract }),
  };
}
/** A temporary directory is reached through a link on macOS, and the host opens the canonical path. */
const canonical = (path: string): string => realpathSync(path);
const listing = (path: string, branch: string): string =>
  ["worktree " + path, "HEAD abc", "branch " + branch, ""].join("\0") + "\0";
const git = (stdout: string): Execute => () =>
  Promise.resolve({ code: 0, stdout, stderr: "", cancelled: false });

describe("ticketWorktree", () => {
  it("opens the worktree holding the branch the ticket's delivery names", async () => {
    const repo = repository();
    const worktree = join(repo.path, "..", "work-PRB-1");
    mkdirSync(worktree, { recursive: true });
    const found = await ticketWorktree(
      {
        tickets: records({ delivery: { branch: "prb/1/delivered", pull_request_url: null } as Ticket["delivery"] }),
        execute: git(listing(worktree, "refs/heads/prb/1/delivered")),
      },
      repo,
      "PRB-1",
    );
    expect(found).toBe(canonical(worktree));
  });

  it("derives a branch only where the records name none", async () => {
    const repo = repository();
    const worktree = join(repo.path, "..", "work-derived");
    mkdirSync(worktree, { recursive: true });
    let asked = "";
    const execute: Execute = () => {
      asked = "asked";
      return Promise.resolve({
        code: 0,
        stdout: listing(worktree, "refs/heads/prb/1/make-errors-actionable"),
        stderr: "",
        cancelled: false,
      });
    };
    await expect(
      ticketWorktree({ tickets: records(), execute }, repo, "PRB-1"),
    ).resolves.toBe(canonical(worktree));
    expect(asked).toBe("asked");
  });

  it("prefers the branch the last attempt recorded over a derived name", async () => {
    const repo = repository();
    const worktree = join(repo.path, "..", "work-attempt");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(repo.path, ".perbo", "state"), { recursive: true });
    writeFileSync(
      attemptsPath(repo, "ticket_1"),
      JSON.stringify({
        ticket_id: "ticket_1",
        attempts: [{ attempt_id: "att_1", branch: "prb/1/attempted" }],
      }),
    );
    await expect(
      ticketWorktree(
        { tickets: records(), execute: git(listing(worktree, "refs/heads/prb/1/attempted")) },
        repo,
        "PRB-1",
      ),
    ).resolves.toBe(canonical(worktree));
  });

  it("says there is no worktree where Git holds none, or where the folder has gone", async () => {
    const repo = repository();
    await expect(
      ticketWorktree({ tickets: records(), execute: git("") }, repo, "PRB-1"),
    ).rejects.toThrow("no materialized worktree available");
    await expect(
      ticketWorktree(
        {
          tickets: records(),
          execute: git(listing(join(repo.path, "..", "gone"), "refs/heads/prb/1/make-errors-actionable")),
        },
        repo,
        "PRB-1",
      ),
    ).rejects.toThrow("no materialized worktree available");
  });

  it("refuses a relative path, which is not a folder to open", async () => {
    const repo = repository();
    await expect(
      ticketWorktree(
        { tickets: records(), execute: git(listing("work/PRB-1", "refs/heads/prb/1/make-errors-actionable")) },
        repo,
        "PRB-1",
      ),
    ).rejects.toThrow("no materialized worktree available");
  });

  it("refuses a worktree that resolves to the primary checkout", async () => {
    const repo = repository();
    const linked = join(repo.path, "..", "linked");
    symlinkSync(repo.path, linked);
    await expect(
      ticketWorktree(
        { tickets: records(), execute: git(listing(linked, "refs/heads/prb/1/make-errors-actionable")) },
        repo,
        "PRB-1",
      ),
    ).rejects.toThrow("resolves to the primary checkout");
  });
});

describe("pullRequestUrl", () => {
  const detail = (url: string | null): Detail =>
    ({ ticket: { delivery: { pull_request_url: url } } }) as Detail;
  it("hands back a GitHub pull-request URL", () => {
    expect(pullRequestUrl(detail("https://github.com/perbo/perbo/pull/12"))).toBe(
      "https://github.com/perbo/perbo/pull/12",
    );
  });

  it("refuses anything else with the same sentence", () => {
    for (const url of [
      null,
      "",
      "http://github.com/perbo/perbo/pull/12",
      "https://github.com/perbo/perbo/pull/12/files",
      "https://example.invalid/perbo/perbo/pull/12",
      "https://github.com/perbo/perbo/pull/abc",
      "https://github.com.evil.example/perbo/perbo/pull/12",
    ])
      expect(() => pullRequestUrl(detail(url))).toThrow(
        "This task has no supported GitHub pull-request URL.",
      );
  });
});
