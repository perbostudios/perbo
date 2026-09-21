import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UsageError } from "../usage-error.js";
import { admitCommandLine, admitDraft, defaultAdmission } from "./admit.js";
import { collectOutput } from "../diagnostics.js";
import { readTicket, storeDir } from "../store/tickets.js";

/**
 * What an admission is allowed to be, whoever asks for it.
 *
 * The terminal reads a line into the same input a caller in this process
 * builds by hand, so a rule about a value holds for both. The one difference
 * is the one D-072 draws: a person at the terminal can approve what they
 * admitted, and nothing in this process can.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-typed-admission-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repository(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return dir;
}

const typed = (repo: string) => ({
  ...defaultAdmission({ repo, store: null }),
  title: "Search results paginate",
  criteria: ["a page holds 20 :: a unit test asserts it :: test"],
  paths: ["src/search/**"],
});

const context = (repo: string) => ({
  cwd: repo,
  now: new Date("2026-09-21T09:00:00.000Z"),
  diagnostics: collectOutput().streams,
});

describe("a draft cannot approve what it admits", () => {
  it("refuses an approval among its fields rather than dropping it", () => {
    const repo = repository("approve-refused");
    expect(() =>
      admitDraft({ ...typed(repo), approve: true } as never, context(repo)),
    ).toThrow(UsageError);
    // And the ticket stays where a person has to read it.
    const report = admitDraft(typed(repo), context(repo));
    expect(report).not.toBeInstanceOf(Promise);
    expect((report as { ticket: { state: string } }).ticket.state).toBe("plan_review");
  });

  it("is the one thing the terminal can ask for that this cannot", () => {
    const repo = repository("approve-allowed");
    expect(admitCommandLine.read(["--approve"]).input.approve).toBe(true);
    expect(Object.keys(defaultAdmission({ repo, store: null }))).not.toContain("approve");
  });
});

describe("the report names the ticket that was written", () => {
  it("gives back the key the store now holds, so no caller reads it out of the bytes", () => {
    const repo = repository("report-key");
    const report = admitDraft(typed(repo), context(repo));
    expect(report).not.toBeInstanceOf(Promise);
    const written = report as { key: string; storedAt: string; ticket: { key: string } };
    expect(written.key).toBe("PRB-1");
    expect(written.ticket.key).toBe(written.key);
    expect(readTicket(storeDir(repo, null), written.key).title).toBe("Search results paginate");
    expect(written.storedAt).toBe(join(".perbo", "tickets", "PRB-1.json"));
  });
});

describe("what a value has to be holds for a caller in this process too", () => {
  const repo = () => repository(`values-${Math.random().toString(36).slice(2, 8)}`);

  it("refuses two sources for one draft", () => {
    const dir = repo();
    expect(() =>
      admitDraft(
        { ...defaultAdmission({ repo: dir, store: null }), from: "o/r#412", fromFile: "issue.md" },
        context(dir),
      ),
    ).toThrow(/--from and --from-file are mutually exclusive/);
  });

  it("refuses an issue reference, a model id and a dependency the terminal would refuse", () => {
    const dir = repo();
    const draft = (fields: Record<string, unknown>) =>
      admitDraft({ ...defaultAdmission({ repo: dir, store: null }), ...fields } as never, context(dir));
    expect(() => draft({ from: "not-an-issue" })).toThrow(
      /--from must be a GitHub issue like owner\/repo#412/,
    );
    expect(() => draft({ model: "--dangerously-skip-permissions" })).toThrow(
      /--model must be a model id like claude-opus-5/,
    );
    expect(() => draft({ dependsOn: ["prb-1"] })).toThrow(/--depends-on must be a ticket key/);
    expect(() => draft({ priority: "later" })).toThrow(/--priority must be urgent, high, normal or low/);
  });
});

describe("a model id is a model id at the terminal as well", () => {
  it("refuses one shaped like a flag, which is what the provider would be started with", () => {
    expect(() =>
      admitCommandLine.read(["--from", "o/r#412", "--model", "--oops"]).input,
    ).toThrow(/--model must be a model id like claude-opus-5/);
    expect(admitCommandLine.read(["--model", "claude-opus-5"]).input.model).toBe("claude-opus-5");
  });
});
