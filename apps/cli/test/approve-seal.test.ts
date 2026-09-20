import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UsageError } from "../src/usage-error.js";
import { loadAdmitted, parseAdmitArgs, runAdmitCommand, runApproveCommand } from "../src/admit.js";
import type { Streams } from "../src/streams.js";
import { runEditCommand } from "../src/edit.js";
import { parseExecuteArgs, runExecuteCommand } from "../src/execute.js";
import { readContract, readDraftSnapshot, readTicket, storeDir } from "../src/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./spawn-timeout.js";

/**
 * The two contracts a ticket carries, and what happens when they part company.
 *
 * `<KEY>.contract.json` is what a run binds to; `<KEY>.draft.json` holds the
 * same contract as it was shown to the person. Admission writes both from one
 * object and `perbo edit` rewrites both, so a difference between them is a
 * text editor — nobody was shown the contract that would execute. Approval is
 * where that is caught, because it is the last moment a person can put it
 * right; `perbo run --ticket` checks it again, because that is the moment it
 * decides what an attempt is judged against.
 *
 * A missing or unreadable counter-seal counts as a difference, or the check
 * would be one a `rm` opts out of. What makes that safe for the stores already
 * on disk is `admission.counter_sealed_at`: nothing is required of a ticket
 * admitted before the pair was kept in step.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-approve-seal-"));
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

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

/** One admitted, unapproved ticket over `packages/search/**`, which derives P1. */
function admitted(name: string): { repo: string; dir: string } {
  const repo = repository(name);
  runAdmitCommand({
    args: parseAdmitArgs([
      "--repo", repo,
      "--outcome", "Search results are paginated.",
      "--criterion", "A search returns at most 25 hits per page. :: a 140-hit query returns 25",
      "--path", "packages/search/**",
    ]),
    streams: capture(),
    cwd: repo,
  });
  return { repo, dir: storeDir(repo, null) };
}

const draftPath = (dir: string, key: string) => join(dir, "tickets", `${key}.draft.json`);
const contractPath = (dir: string, key: string) => join(dir, "tickets", `${key}.contract.json`);
const ticketPath = (dir: string, key: string) => join(dir, "tickets", `${key}.json`);

/** As much of a stored contract as a hand edit here reaches into. */
interface StoredContract {
  outcome: string;
  scope: { paths_allowed: string[] };
}

/** Edit the draft file the way a person with a text editor would. */
function handEditDraft(dir: string, key: string, mutate: (contract: StoredContract) => void): void {
  const path = draftPath(dir, key);
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as { contract: StoredContract };
  mutate(snapshot.contract);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** The same, to the contract file. */
function handEditContract(dir: string, key: string, mutate: (contract: StoredContract) => void): void {
  const path = contractPath(dir, key);
  const contract = JSON.parse(readFileSync(path, "utf8")) as StoredContract;
  mutate(contract);
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
}

/**
 * The store as the version before counter-seals left it: the contract edited,
 * the draft still holding the contract admission rendered, and a ticket file
 * with no `counter_sealed_at` key at all — that version did not write one.
 *
 * Everything here beyond removing the key is what its `perbo edit --path` did:
 * it rewrote `<KEY>.contract.json` alone. The two glob changes are the edit; the
 * scope stays inside one ordinary package, so the level it derived is unchanged.
 */
function asEditedByThePreviousVersion(dir: string, key: string): void {
  handEditContract(dir, key, (contract) => {
    contract.scope.paths_allowed = ["packages/search/api/**"];
  });
  const path = ticketPath(dir, key);
  const ticket = JSON.parse(readFileSync(path, "utf8")) as {
    admission: Record<string, unknown>;
  };
  delete ticket.admission["counter_sealed_at"];
  writeFileSync(path, `${JSON.stringify(ticket, null, 2)}\n`);
}

/** Every file under the store, with its bytes: what the command left behind. */
function storeContents(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

/**
 * Every refusal below still tries `runExecuteCommand` once against a real
 * repository, a cold spawn under the load SCP-191 measures rather than an
 * idle machine's five seconds.
 */
const REFUSAL_TIMEOUT_MS = 60_000;

describe("a contract is refused when it does not match the counter-seal beside it", () => {
  it("refuses a hand-edited draft, starts no attempt and leaves the ticket unapproved", async () => {
    const { repo, dir } = admitted("seal-scope");
    handEditDraft(dir, "PRB-1", (contract) => {
      contract.scope.paths_allowed = ["**"];
    });
    const before = storeContents(dir);

    const streams = capture();
    expect(() => runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo })).toThrow(
      UsageError,
    );

    // Unapproved, and nothing else in the store moved either: no run record, no
    // attempt directory, not even a rewritten ticket file.
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.approved_at).toBeNull();
    expect(ticket.state).toBe("plan_review");
    expect(storeContents(dir)).toEqual(before);

    // And the one command that starts an attempt still cannot take it: an
    // attempt binds to an approved contract, and this ticket has none.
    await expect(
      runExecuteCommand({
        args: parseExecuteArgs(["--ticket", "PRB-1", "--repo", repo]),
        streams: capture(),
        cwd: repo,
      }),
    ).rejects.toThrow(/has not been approved/);
    expect(storeContents(dir)).toEqual(before);
  }, REFUSAL_TIMEOUT_MS);

  it("names every field that differs and sends the person to perbo edit", () => {
    const { repo, dir } = admitted("seal-two-fields");
    handEditDraft(dir, "PRB-1", (contract) => {
      contract.outcome = "Search results are paginated at 25 per page.";
      contract.scope.paths_allowed = ["packages/search/**", "packages/api/**"];
    });

    let message = "";
    try {
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo });
      expect.unreachable("approve accepted a hand-edited draft");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      message = (error as Error).message;
    }

    // Both edited fields, named by the path they live at in the file, and
    // nothing else claimed as differing.
    expect(message).toContain("differ at 2 fields — outcome, scope.paths_allowed[1].");
    expect(message).toContain("perbo edit");
    // The refusal is about these two files, and says which ticket's.
    expect(message).toContain("PRB-1.draft.json");
    expect(message).toContain("PRB-1.contract.json");
    expect(readTicket(dir, "PRB-1").approved_at).toBeNull();
  });

  it("refuses a hand-edited contract too: the check is not about which file was touched", () => {
    const { repo, dir } = admitted("seal-contract-side");
    const path = join(dir, "tickets", "PRB-1.contract.json");
    const contract = JSON.parse(readFileSync(path, "utf8")) as StoredContract;
    contract.scope.paths_allowed = ["**"];
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);

    expect(() =>
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo }),
    ).toThrow(/scope\.paths_allowed\[0\]/);
    expect(readTicket(dir, "PRB-1").approved_at).toBeNull();
  });

  it("reports no edits for a difference it refused, and the edits perbo edit made for one it took", async () => {
    const { repo, dir } = admitted("seal-not-an-edit");
    handEditDraft(dir, "PRB-1", (contract) => {
      contract.outcome = "Search results are paginated, and sorted by relevance.";
    });

    const refused = capture();
    expect(() =>
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: refused, cwd: repo }),
    ).toThrow(UsageError);
    // No approval summary at all, so no line in one calling that difference an
    // edit, and nothing recorded against the ticket either.
    expect(refused.err.join("")).toBe("");
    expect(refused.out.join("")).toBe("");
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBeNull();

    // The way out is the one the refusal names. `perbo edit` reports what it
    // applied — one glob for another — and rewrites both files, so they agree.
    const edited = capture();
    await runEditCommand({
      argv: ["PRB-1", "--repo", repo, "--path", "packages/search/api/**"],
      streams: edited,
      cwd: repo,
    });
    expect(edited.err.join("")).toContain("2 changes");
    expect(edited.err.join("")).toContain("scope +packages/search/api/**");
    expect(edited.err.join("")).toContain("scope -packages/search/**");
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(2);

    // The approval summary carries those edits and nothing about the hand edit:
    // the outcome a text editor changed was never applied to either file.
    const approve = capture();
    expect(runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: approve, cwd: repo })).toBe(0);
    const summary = approve.err.join("");
    expect(summary).toContain("2 edits");
    expect(summary).toContain("scope +packages/search/api/**");
    expect(summary).not.toContain("sorted by relevance");
    expect(readContract(dir, "PRB-1").outcome).toBe("Search results are paginated.");
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(2);
  });

  it("approves a contract perbo edit changed, sealing that scope and the level it re-derived", async () => {
    const { repo, dir } = admitted("seal-edited-approves");
    expect(readContract(dir, "PRB-1").level).toBe("P1");

    await runEditCommand({
      argv: ["PRB-1", "--repo", repo, "--path", "packages/auth/**"],
      streams: capture(),
      cwd: repo,
    });

    const approve = capture();
    expect(runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: approve, cwd: repo })).toBe(0);

    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("ready");
    expect(ticket.approved_at).not.toBeNull();

    // The sealed contract is the edited one, at the level the new scope
    // derives — not the scope or the level admission wrote.
    const sealed = readContract(dir, "PRB-1");
    expect(sealed.scope.paths_allowed).toEqual(["packages/auth/**"]);
    expect(sealed.level).toBe("P2");
    expect(ticket.admission.derived_level).toBe("P2");
    expect(readDraftSnapshot(dir, "PRB-1")?.contract).toEqual(sealed);

    // And it is immutable from here: the way to change it is new work.
    await expect(
      runEditCommand({
        argv: ["PRB-1", "--repo", repo, "--path", "packages/billing/**"],
        streams: capture(),
        cwd: repo,
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses a ticket whose draft file was deleted, so the check cannot be opted out of", async () => {
    const { repo, dir } = admitted("seal-no-draft");
    // The hand edit an adversary would reach for instead: remove the file that
    // would disagree with the contract. The ticket records that admission wrote
    // one, so its absence is the same refusal as its disagreement.
    handEditContract(dir, "PRB-1", (contract) => {
      contract.scope.paths_allowed = ["**"];
    });
    rmSync(draftPath(dir, "PRB-1"));

    const approve = capture();
    let message = "";
    try {
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: approve, cwd: repo });
      expect.unreachable("approve accepted a contract with no counter-seal");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      message = (error as Error).message;
    }
    expect(message).toContain("PRB-1.draft.json is missing");
    expect(message).toContain("perbo edit PRB-1");
    expect(approve.out.join("")).toBe("");
    expect(readTicket(dir, "PRB-1").approved_at).toBeNull();

    await expect(
      runExecuteCommand({
        args: parseExecuteArgs(["--ticket", "PRB-1", "--repo", repo]),
        streams: capture(),
        cwd: repo,
      }),
    ).rejects.toThrow(/has not been approved/);
  }, REFUSAL_TIMEOUT_MS);

  it("says what it cannot read, rather than the parse error, and perbo edit puts it back", async () => {
    const { repo, dir } = admitted("seal-unreadable-draft");
    // One text editor, two casualties: the contract's scope, and the JSON of
    // the file that would have disagreed with it.
    handEditContract(dir, "PRB-1", (contract) => {
      contract.scope.paths_allowed = ["**"];
    });
    writeFileSync(draftPath(dir, "PRB-1"), '{"contract": {,,,\n');

    let message = "";
    try {
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo });
      expect.unreachable("approve accepted an unreadable counter-seal");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      message = (error as Error).message;
    }
    expect(message).toContain("PRB-1.draft.json cannot be read");
    expect(message).toContain("it is not JSON");
    expect(message).toContain("perbo edit PRB-1");
    expect(readTicket(dir, "PRB-1").approved_at).toBeNull();

    // The remedy the refusal names has to work on the state it names it for:
    // the edit writes the pair again, saying what the broken file cost.
    const edited = capture();
    await runEditCommand({
      argv: ["PRB-1", "--repo", repo, "--path", "packages/search/**"],
      streams: edited,
      cwd: repo,
    });
    expect(edited.err.join("")).toContain("PRB-1.draft.json cannot be read");
    expect(runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
    expect(readContract(dir, "PRB-1").scope.paths_allowed).toEqual(["packages/search/**"]);
    expect(readDraftSnapshot(dir, "PRB-1")?.contract).toEqual(readContract(dir, "PRB-1"));
  });

  it("refuses to bind an attempt to a contract hand-edited after it was approved", async () => {
    const { repo, dir } = admitted("seal-after-approval");
    expect(runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
    handEditContract(dir, "PRB-1", (contract) => {
      contract.scope.paths_allowed = ["**"];
    });
    const before = storeContents(dir);

    const failure: unknown = await runExecuteCommand({
      args: parseExecuteArgs(["--ticket", "PRB-1", "--repo", repo]),
      streams: capture(),
      cwd: repo,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    const message = (failure as Error).message;
    expect(message).toContain("PRB-1 cannot be run");
    expect(message).toContain("scope.paths_allowed[0]");
    // The remedy is not an edit here: the contract was approved, and an
    // approved contract is immutable, so the file it came from is the way back.
    expect(message).toContain("immutable");
    expect(message).toContain("version control");
    // Nothing started: no attempt, no run record, not a byte moved.
    expect(storeContents(dir)).toEqual(before);
  }, REFUSAL_TIMEOUT_MS);

  it("leaves a store from before counter-seals alone: not approved, not run, not accused", async () => {
    const { repo, dir } = admitted("seal-legacy-store");
    asEditedByThePreviousVersion(dir, "PRB-1");
    expect(readTicket(dir, "PRB-1").admission.counter_sealed_at).toBeNull();

    // Approval takes it. Nothing wrote the pair together for this ticket, so
    // the difference between the two files is that version's own edit, and it
    // is measured the way that version measured it.
    const approve = capture();
    expect(runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: approve, cwd: repo })).toBe(0);
    expect(approve.err.join("")).toContain("2 edits");
    expect(approve.err.join("")).toContain("scope +packages/search/api/**");
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(2);

    // And an attempt can still bind to it: the counter-seal is required of the
    // tickets that were written with one, not of every ticket ever admitted.
    const loaded = loadAdmitted(repo, repo, null, "PRB-1");
    expect(loaded.contract.scope.paths_allowed).toEqual(["packages/search/api/**"]);
  });

  it("counter-seals a ticket from before them at its first edit, keeping the earlier count", async () => {
    const { repo, dir } = admitted("seal-legacy-edited");
    asEditedByThePreviousVersion(dir, "PRB-1");

    await runEditCommand({
      argv: ["PRB-1", "--repo", repo, "--outcome", "Search results are paginated at 25 per page."],
      streams: capture(),
      cwd: repo,
    });

    // Sealed from here: the pair agrees, the ticket says so, and the count
    // carries the two globs the previous version changed as well as the
    // outcome this edit did.
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.admission.counter_sealed_at).not.toBeNull();
    expect(readDraftSnapshot(dir, "PRB-1")?.contract).toEqual(readContract(dir, "PRB-1"));
    expect(ticket.admission.edit_count).toBe(3);

    // A hand edit after that seal is refused like any other.
    handEditDraft(dir, "PRB-1", (contract) => {
      contract.outcome = "Search results are paginated at 10 per page.";
    });
    expect(() =>
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo }),
    ).toThrow(/differ at 1 field — outcome/);
  });
}, SPAWN_TEST_TIMEOUT_MS);
