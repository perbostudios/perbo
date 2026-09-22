import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { win32 } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { StoredTicketSchema, type Ticket } from "@perbo/contracts";
import { TicketRunConfigSchema } from "@perbo/runner";
import { admitCommandLine } from "./admit.js";
import { TICKET_RUNS } from "./run/index.js";
import { TicketStoreError, listTickets, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * A ticket file names no machine.
 *
 * The store is committed — `<repo>/.perbo/tickets/PRB-118.json` is in the
 * history like any other file — so every ticket is read from clones its author
 * never had: a colleague's checkout, a worktree, a CI runner, a `git clone`
 * into a temporary directory. A `repository_root` of `/Users/somebody/perbo`
 * survived none of those, and what it took down with it was not a display
 * string: `run` provisions worktrees under that path and `sync` polls the pull
 * request from it, so a ticket read anywhere else acted on a checkout the
 * person was not looking at, or on nothing at all.
 *
 * These are end-to-end over the real commands and the real store: `admit`
 * writes the file, the file is read back as bytes, and the reading is done from
 * a copy of the repository at a path admission never saw.
 *
 * Every case spawns several real `git` processes and recursively copies a
 * repository, so each carries an explicit timeout (SCP-246, in SCP-191's
 * style) rather than vitest's five-second default: on a machine also running
 * gates and mutant attempts, that work can outrun five seconds on its own.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "perbo-repository-root-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: GIT_ENV });

function repository(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  return dir;
}

/**
 * A second checkout of `src`, at a path admission never saw — the same thing
 * a `git clone` into a temporary directory produces, and the same thing a
 * second machine has.
 *
 * Not `cpSync`: a recursive `readdir`-based copy of a live `.git` failed with
 * ENOENT on `.git/objects` in CI (run 34006197228, attempt 1) — not
 * reproduced locally, cause not established. `git clone` reads objects
 * through git rather than walking the directory; `--no-hardlinks` keeps the
 * copy's objects independent of the source's rather than sharing inodes
 * with it.
 */
function cloneRepository(src: string, dest: string): void {
  execFileSync("git", ["clone", "--no-hardlinks", "-q", src, dest], { env: GIT_ENV });
}

/** Admit and approve one ticket in `repo`, then commit the store it wrote. */
function admitted(repo: string): void {
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo",
      repo,
      "--outcome",
      "Activation email goes out within 60 seconds.",
      "--criterion",
      "A signup queues exactly one email. :: one message on the queue",
      "--path",
      "packages/auth/**",
      "--approve",
    ],
    streams: recordStreams(),
    cwd: repo,
  });
  expect(code).toBe(0);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "admit PRB-1");
}

/** The bytes `admit` wrote, parsed but not validated: what is actually on disk. */
const storedJson = (repo: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8")) as Record<
    string,
    unknown
  >;

/** Absolute on either platform's rules, which is what a travelling record is read under. */
const absoluteAnywhere = (path: string) => isAbsolute(path) || win32.isAbsolute(path);

/** What `<store>/tickets/<key>.json` says its repository root is, as bytes on disk. */
const storedRoot = (dir: string, key: string): string =>
  String(
    (JSON.parse(readFileSync(join(dir, "tickets", `${key}.json`), "utf8")) as Record<string, unknown>)[
      "repository_root"
    ],
  );

/**
 * Put a ticket back into the shape one admitted before this field was relative
 * has: the admitting machine's own absolute directory in `repository_root`.
 *
 * Written by hand because no writer produces it any more — which is the point.
 * A fixture read out of this repository's own store would stop being a legacy
 * record the first time anything wrote that ticket, and the migration it covers
 * would go untested from then on without anything failing.
 */
function legacyRoot(dir: string, key: string, root: string): void {
  const path = join(dir, "tickets", `${key}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...record, repository_root: root }, null, 2)}\n`);
}

/**
 * What the store wrote to stderr while `read` ran, and what `read` returned.
 *
 * The store warns on the process's own stderr, as `listTickets` does for a file
 * it could not read: these are commands, and a warning a command's caller has
 * to opt into is one nobody sees.
 */
function warningsFrom<T>(read: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
  try {
    return { value: read(), warnings };
  } finally {
    spy.mockRestore();
  }
}

describe("a ticket admission writes", () => {
  it("records no absolute filesystem path as its repository root", () => {
    const repo = repository("admits");
    admitted(repo);

    const stored = storedJson(repo);
    const root = stored["repository_root"];
    expect(typeof root).toBe("string");
    expect(absoluteAnywhere(root as string)).toBe(false);
    // The store sits at `<repo>/.perbo`, so the repository is one directory up.
    expect(root).toBe("..");

    // And nothing else in the file smuggles the path back in: a typed admission
    // has no file source, so the admitting checkout must appear nowhere at all.
    expect(readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8")).not.toContain(
      repo,
    );
  }, 30_000);

  it("keeps writing it relatively as the ticket is moved through its states", () => {
    const repo = repository("rewrites");
    admitted(repo);
    const dir = storeDir(repo, null);

    // Every later command re-writes the whole ticket. The relativisation is in
    // the store's writer rather than in `admit`, so a state change cannot put a
    // machine's path back.
    writeTicket(dir, readTicket(dir, "PRB-1"));
    expect(storedJson(repo)["repository_root"]).toBe("..");
  }, 30_000);

  it("relativises against a store pointed outside the default place", () => {
    const repo = repository("elsewhere");
    const store = join(scratch, "elsewhere-store");
    mkdirSync(store, { recursive: true });
    const code = runCommandLine(admitCommandLine, {
      argv: [
        "--repo",
        repo,
        "--store",
        store,
        "--outcome",
        "Activation email goes out within 60 seconds.",
        "--criterion",
        "A signup queues exactly one email. :: one message on the queue",
        "--path",
        "packages/auth/**",
      ],
      streams: recordStreams(),
      cwd: repo,
    });
    expect(code).toBe(0);

    const stored = JSON.parse(
      readFileSync(join(store, "tickets", "PRB-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(absoluteAnywhere(stored["repository_root"] as string)).toBe(false);
    expect(readTicket(store, "PRB-1").repository_root).toBe(repo);
  }, 30_000);
});

describe("a committed ticket read from another clone", () => {
  it("resolves its repository root to the clone it was read out of", () => {
    const repo = repository("origin");
    admitted(repo);

    // A copy of the repository at a path admission never saw.
    const clone = join(scratch, "clone");
    cloneRepository(repo, clone);

    const dir = storeDir(clone, null);
    expect(readTicket(dir, "PRB-1").repository_root).toBe(clone);
    expect(listTickets(dir).map((ticket) => ticket.repository_root)).toEqual([clone]);
    // Not the directory it was admitted in, which still exists and is wrong.
    expect(readTicket(dir, "PRB-1").repository_root).not.toBe(repo);
  }, 30_000);

  it("gives `run` the second clone to work in", () => {
    const repo = repository("run-origin");
    admitted(repo);
    const clone = join(scratch, "run-clone");
    cloneRepository(repo, clone);

    const work = TICKET_RUNS.load({ cwd: clone, repo: ".", store: null, key: "PRB-1" });
    const config = TicketRunConfigSchema.parse(TICKET_RUNS.runConfig(work, undefined, false));
    expect(config.repository_root).toBe(clone);
  }, 30_000);

  it("ignores the absolute path a ticket admitted before this was relative carries", () => {
    const admitting = repository("legacy-origin");
    admitted(admitting);
    const clone = join(scratch, "legacy-clone");
    cloneRepository(admitting, clone);
    // The shape a ticket admitted before this field was relative has on disk.
    // Written here rather than taken from this repository's own store, because
    // the first write of each of those rewrites it: a fixture read out of the
    // tree stops being a legacy record the moment the migration has done its
    // work, and the coverage would expire with it.
    const dir = storeDir(clone, null);
    legacyRoot(dir, "PRB-1", admitting);

    const read = warningsFrom(() => readTicket(dir, "PRB-1"));
    expect(read.value.repository_root).toBe(clone);
    // The path the file names is real, is on this machine, and is not what was used.
    expect(absoluteAnywhere(storedRoot(dir, "PRB-1"))).toBe(true);
    expect(read.value.repository_root).not.toBe(admitting);
    // Silently, because a ticket file inside `<repo>/.perbo` is a record of the
    // checkout it is in and of nothing else. The directory it names exists on
    // this machine — it is the checkout it was copied from — and a line about
    // that for every legacy ticket in the store would be noise, not news.
    expect(read.warnings).toEqual([]);
    const ticket = read.value;

    // Re-writing it drops the author's path for good.
    writeTicket(dir, ticket);
    expect(storedRoot(dir, "PRB-1")).toBe("..");
  }, 30_000);

  it("names both directories when a store outside its repository reads one", () => {
    // A store pointed somewhere else with `--store` has a parent that is not
    // the repository, so dropping the recorded path is a choice between two
    // real directories rather than the only reading left. `run` provisions
    // worktrees under the one that wins and `sync` polls the pull request from
    // it, so the one that lost is named on stderr instead of disappearing.
    const admitting = repository("relocated-origin");
    admitted(admitting);
    const elsewhere = join(scratch, "relocated");
    const store = join(elsewhere, "store");
    mkdirSync(store, { recursive: true });
    cpSync(join(admitting, ".perbo", "tickets"), join(store, "tickets"), { recursive: true });
    legacyRoot(store, "PRB-1", admitting);

    const read = warningsFrom(() => readTicket(store, "PRB-1"));
    expect(read.value.repository_root).toBe(elsewhere);
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain(admitting);
    expect(read.warnings[0]).toContain(elsewhere);
    // `list` reads the same file through the same migration, and says the same.
    const listed = warningsFrom(() => listTickets(store));
    expect(listed.value.map((ticket) => ticket.repository_root)).toEqual([elsewhere]);
    expect(listed.warnings).toHaveLength(1);
  }, 30_000);

  it("says nothing, even outside a repository, when the path is not on this machine", () => {
    // The other half of the condition, and the ordinary case for a record that
    // has travelled: the directory the admitting machine named is simply not
    // here, so there is no second candidate to weigh and nothing to report.
    const admitting = repository("absent-origin");
    admitted(admitting);
    const elsewhere = join(scratch, "absent-relocated");
    const store = join(elsewhere, "store");
    mkdirSync(store, { recursive: true });
    cpSync(join(admitting, ".perbo", "tickets"), join(store, "tickets"), { recursive: true });
    legacyRoot(store, "PRB-1", join(scratch, "no-such-machine", "perbo"));

    const read = warningsFrom(() => readTicket(store, "PRB-1"));
    expect(read.value.repository_root).toBe(elsewhere);
    expect(read.warnings).toEqual([]);
  }, 30_000);
});

describe("the store's writer", () => {
  it("refuses a record the reader would not accept, and writes nothing", () => {
    const repo = repository("refuses");
    admitted(repo);
    const dir = storeDir(repo, null);
    const before = readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8");
    const ticket = readTicket(dir, "PRB-1");

    // The type says a ticket is valid; only a parse checks it. `writeTicket`
    // parses what it is about to write with the schema that reads it back, so
    // a record that could not be read is a failure at the write rather than a
    // file nothing can load afterwards.
    expect(() =>
      writeTicket(dir, { ...ticket, state: "somewhere-else" } as unknown as Ticket),
    ).toThrow(TicketStoreError);
    expect(readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8")).toBe(before);
  }, 30_000);

  it("parses with a schema that refuses an absolute repository root", () => {
    // The one arrangement where the relativisation cannot deliver a relative
    // path is a store on a different Windows drive from its repository, where
    // `relative` has no path to return and returns an absolute one. There is no
    // such arrangement on this platform to drive it from, so what is asserted
    // is the refusal itself, in the schema `writeTicket` parses through: the
    // record above proves the parse happens, and this proves what it catches.
    const repo = repository("absolute-refused");
    admitted(repo);
    const stored = storedJson(repo);
    expect(StoredTicketSchema.safeParse(stored).success).toBe(true);
    for (const root of ["/Users/somebody/perbo", "C:\\Users\\somebody\\perbo"]) {
      const refused = StoredTicketSchema.safeParse({ ...stored, repository_root: root });
      expect(refused.success, `${root} was accepted as a stored repository root`).toBe(false);
      expect(refused.error?.issues[0]?.message).toContain("must be relative");
    }
  }, 30_000);
});
