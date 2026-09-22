import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specBaseline, specStaleness } from "./staleness.js";
import { indexCommandLine } from "../commands/symbol-index.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * Whether a ticket's spec is still the one its contract was drafted from
 * (D-103): the file's own bytes, and the `@Symbol` and path names in it that
 * this repository had when the plan was approved.
 *
 * Every repository here is a real git checkout with a real `.perbo/index.json`
 * built by `perbo index` over it, because the two questions this answers are
 * both about a tree on disk and a double for either would be a double for the
 * thing under test. Every baseline is the one {@link specBaseline} writes
 * at approval, taken at the moment the fixture says approval happened, so a
 * test that asks whether a name is stale has first said whether it was there.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-spec-staleness-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv });

const hashOf = (path: string): string =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues one email through @sendActivation.
- R2: The retry policy in \`packages/queue/retry.ts\` is unchanged.

## Notes

The queue package already has a sender.
`;

let repos = 0;

/**
 * A checkout with one commit, a spec, two exported symbols and an index over it.
 *
 * `extra` writes further files into the tree before the commit, by
 * repository-relative path: what a fixture needs beside the two the spec names.
 */
function repository(spec = SPEC, extra: Record<string, string> = {}): { repo: string; specPath: string } {
  const repo = join(scratch, `repo-${repos++}`);
  mkdirSync(join(repo, "specs", "activation-email"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  const specPath = join(repo, "specs", "activation-email", "spec.md");
  writeFileSync(specPath, spec);
  mkdirSync(join(repo, "packages", "queue"), { recursive: true });
  writeFileSync(
    join(repo, "packages", "queue", "send.ts"),
    "export function sendActivation(): number {\n  return 1;\n}\n",
  );
  writeFileSync(join(repo, "packages", "queue", "retry.ts"), "export const retries = 3;\n");
  for (const [path, content] of Object.entries(extra)) {
    const at = join(repo, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  index(repo);
  return { repo, specPath };
}

/** `perbo index --repo <dir>`, which is what writes the record the check reads. */
function index(repo: string): void {
  const code = runCommandLine(indexCommandLine, {
    argv: ["--repo", repo],
    streams: recordStreams(),
    cwd: repo,
  });
  expect(code).toBe(0);
}

/** The record `perbo index` wrote, for a fixture that has to say what it holds. */
const readIndex = (repo: string): { skipped: { path: string }[] } =>
  JSON.parse(readFileSync(join(repo, ".perbo", "index.json"), "utf8")) as { skipped: { path: string }[] };

/**
 * What a case gets when it has to build more than one checkout.
 *
 * Every one of these runs `git init`, commits and then `perbo index`, which is
 * around half a second unloaded — so a case that needs two or three of them is
 * already most of vitest's 5s default before the load of the whole-repository
 * step is on the machine, and over it once the machine carries any load. Where
 * the spellings are independent the answer is a case each (`it.each` below);
 * where one case genuinely needs several checkouts to state its point, it gets
 * this instead. The runner keeps the same constant for its spawn-heavy tests.
 */
const CHECKOUT_TEST_TIMEOUT_MS = 30_000;

const SPEC_PATH = "specs/activation-email/spec.md";

/**
 * The admission record as approval leaves it: the spec's bytes, and the names
 * this repository has at the moment the record is taken.
 */
const recorded = (repo: string, specPath: string, path = SPEC_PATH) => {
  const baseline = specBaseline({ repositoryRoot: repo, specPath: path });
  return {
    path,
    content_sha256: hashOf(specPath),
    files: [],
    names_that_resolved: baseline.names,
    symbols_judged_at_approval: baseline.symbols_judged,
  };
};

/**
 * A record approved before the baseline existed: the key is absent, which is
 * how such a ticket file on disk has it.
 */
const beforeBaseline = (specPath: string, path = SPEC_PATH) => ({
  path,
  content_sha256: hashOf(specPath),
  files: [],
});

/** The reading, of a ticket whose contract was approved unless a case says otherwise. */
const check = (repo: string, spec: Parameters<typeof specStaleness>[0]["spec"], approved = true) =>
  specStaleness({ repositoryRoot: repo, approved, spec });

/** The one sentence a baseline-less record's names are reported in. */
function namesSaid(repo: string, specPath: string): string {
  const answer = check(repo, beforeBaseline(specPath))!;
  expect(answer.stale).toEqual([]);
  expect(answer.unjudged).toHaveLength(1);
  return answer.unjudged[0]!;
}

describe("a spec that is still the one the contract was drafted from", () => {
  it("is not stale, and answers nothing at all for a ticket with no spec", () => {
    const { repo, specPath } = repository();
    expect(check(repo, recorded(repo, specPath))).toEqual({
      path: SPEC_PATH,
      judged_against: "approval",
      stale: [],
      unjudged: [],
    });
    expect(check(repo, null)).toBeNull();
  });
});

describe("which moment the spec is measured from", () => {
  it("measures a contract that has not been approved from admission, and says so", () => {
    // A ticket sits in `plan_review` while a person reads the draft, and
    // editing the spec there is the ordinary thing to do. Telling them the
    // spec was "edited since the contract was approved from it", and to
    // "admit this work again", names a moment that has not happened and a
    // remedy for a ticket they do not have.
    const { repo, specPath } = repository();
    const before = beforeBaseline(specPath);
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const answer = check(repo, before, false)!;
    expect(answer.judged_against).toBe("admission");
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("has been edited since the contract was drafted from it");
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain("has not been approved");
    expect(answer.unjudged[0]).toContain("approving this contract records them");
    expect(answer.unjudged[0]).not.toContain("admit this work again");
  });

  it("measures an approved contract from approval, and says that", () => {
    const { repo, specPath } = repository();
    const before = beforeBaseline(specPath);
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const answer = check(repo, before)!;
    expect(answer.judged_against).toBe("approval");
    expect(answer.stale[0]).toContain("has been edited since the contract was approved from it");
    expect(answer.unjudged[0]).toContain("was approved before the names it carries were recorded");
    expect(answer.unjudged[0]).toContain("admit this work again");
  });
});

describe("a spec edited since approval recorded its bytes", () => {
  it("is stale, naming both hashes", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const answer = check(repo, before)!;
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("has been edited since the contract was approved from it");
    expect(answer.stale[0]).toContain(before.content_sha256);
    expect(answer.stale[0]).toContain(hashOf(specPath));
    // The edit is the whole of what is wrong: the symbols are a separate
    // reading, and this checkout now carries the edit uncommitted, so they are
    // reported unjudged rather than judged against an index built before it.
    expect(answer.unjudged).toHaveLength(1);
  });

  it("is stale where the record names the folder rather than the spec inside it", () => {
    // A record naming a directory resolves to something the repository has,
    // and has no bytes to hash: the two answers are different sentences.
    const { repo, specPath } = repository();
    const answer = check(repo, {
      ...recorded(repo, specPath, "specs/activation-email"),
      content_sha256: hashOf(specPath),
    })!;
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("specs/activation-email cannot be read");
    expect(answer.stale[0]).not.toContain("is not in the repository");
  });

  it("judges nothing at all where the checkout itself is gone", () => {
    // A ticket record travels, and the directory it names need not be on this
    // machine. That is not the spec being stale; it is nothing to read.
    const { repo, specPath } = repository();
    const answer = specStaleness({
      repositoryRoot: join(repo, "not-a-checkout"),
      approved: true,
      spec: recorded(repo, specPath),
    })!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain("cannot be read");
    expect(answer.unjudged[0]).toContain(`so nothing about ${SPEC_PATH} is judged`);
  });

  it("is stale when the file is gone, and says so rather than reading a hash off nothing", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    rmSync(specPath);
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([
      `${SPEC_PATH}, which the contract was drafted from, is not in the repository`,
    ]);
  });
});

/**
 * The reading that decides whether a spec can be written at all: a spec names
 * the work it is for, and the work it is for does not exist yet.
 */
describe("the names the repository had when the plan was approved", () => {
  const PLANNED = `# Retry policy

## Outcome

A failed send is retried with exponential backoff.

## Requirements

- R1: A new policy module at \`packages/queue/retry-policy.ts\` holds the backoff.
- R2: @retryWithBackoff is exported from it and used by @sendActivation.
- R3: The existing policy in \`packages/queue/retry.ts\` is deleted.
`;

  it("does not call a spec stale for naming the work it is for", () => {
    // Every half of R1 and R2 is a name this repository does not have and is
    // not supposed to: the ticket is the reason they will exist. Asking only
    // whether they resolve now would refuse this ticket's very first run and
    // leave it at `plan_invalid`, which has no row out.
    const { repo, specPath } = repository(PLANNED);
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts", "@sendActivation"]);
    expect(check(repo, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  });

  it("is stale only for the names it had and has lost", () => {
    const { repo, specPath } = repository(PLANNED);
    const before = recorded(repo, specPath);
    // R3's work, done: the file the plan was approved against is gone. The
    // names R1 and R2 promise are still absent and still say nothing.
    rmSync(join(repo, "packages", "queue", "retry.ts"));
    git(repo, "commit", "-qam", "delete the old policy");
    index(repo);
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([
      `${SPEC_PATH} names packages/queue/retry.ts, which is not in the repository`,
    ]);
    expect(answer.unjudged).toEqual([]);
  });

  it("records no symbol at all where the index cannot be believed at approval", () => {
    // Nothing at approval could say whether @sendActivation was exported, so
    // nothing later may say it has gone. A baseline is evidence or it is
    // absent; a guess in it would come back as a refused run.
    const { repo, specPath } = repository();
    rmSync(join(repo, ".perbo"), { recursive: true, force: true });
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts"]);
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    git(repo, "commit", "-qam", "rename the sender");
    index(repo);
    expect(check(repo, before)!.stale).toEqual([]);
  });

  it("records no symbol where the index is a record of a commit this tree has left", () => {
    // The flavour of "cannot be believed" the guard above exists for, and the
    // one the test above cannot reach: the index is there, it parses, and it
    // describes a tree that has moved. Believing it would record a name the
    // repository might already have lost, and the next run would call that
    // name gone and leave the ticket at `plan_invalid`, which has no row out.
    const { repo, specPath } = repository();
    appendFileSync(join(repo, "packages", "queue", "retry.ts"), "export const backoff = 2;\n");
    git(repo, "commit", "-qam", "extend the policy");
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts"]);
    expect(before.symbols_judged_at_approval).toBe(false);
    // The export the spec names goes, on a tree the index now describes: under
    // a baseline that had guessed it, this is the refused run. It is not
    // stale, because nothing here ever said the repository had the name — and
    // the reading says that rather than calling the spec current over it.
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    git(repo, "commit", "-qam", "rename the sender");
    index(repo);
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain("@sendActivation");
    expect(answer.unjudged[0]).toContain("could not be believed when this contract was approved");
    expect(answer.unjudged[0]).toContain("perbo index");
  });

  it("judges the symbols of a record written before that flag was recorded", () => {
    // A store outlives the version that wrote it, and a record without the
    // flag was written by a version that took the baseline exactly as this one
    // does: what it recorded was judged, and reading it as unjudged would turn
    // every such ticket's symbol half off.
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts", "@sendActivation"]);
    const legacy: Partial<typeof before> = { ...before };
    delete legacy.symbols_judged_at_approval;
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    git(repo, "commit", "-qam", "rename the sender");
    index(repo);
    const answer = check(repo, legacy as typeof before)!;
    expect(answer.unjudged).toEqual([]);
    expect(answer.stale).toEqual([
      `${SPEC_PATH} names @sendActivation, which nothing in the repository exports`,
    ]);
  });

  it("says the index was believed even where the spec itself could not be read", () => {
    // Two separate questions, and the flag answers only the first. A spec that
    // could not be read leaves the baseline empty for its own reason; saying
    // the index could not be believed would name a cause that is not the one,
    // and send a person to rebuild an index that is already right.
    const { repo } = repository();
    expect(specBaseline({ repositoryRoot: repo, specPath: "specs/gone/spec.md" })).toEqual({
      names: [],
      content_sha256: null,
      symbols_judged: true,
    });
  });

  it("says nothing about symbols approval could not judge where the spec names none", () => {
    // The guard every other sentence in here has. A spec naming only paths has
    // no symbol to report, and a warning naming none of them would ride every
    // run of that ticket for the life of the ticket.
    const { repo, specPath } = repository(SPEC.replace("@sendActivation", "the queue"));
    appendFileSync(join(repo, "packages", "queue", "send.ts"), "export const extra = 1;\n");
    const before = recorded(repo, specPath);
    expect(before.symbols_judged_at_approval).toBe(false);
    expect(check(repo, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  });

  it("records no symbol where the tree carries changes the index was not built over", () => {
    // The other flavour, and the one an interview that edited `CONTEXT.md` or
    // an ADR leaves a person sitting in at the moment they approve.
    const { repo, specPath } = repository();
    appendFileSync(join(repo, "packages", "queue", "retry.ts"), "export const backoff = 2;\n");
    expect(recorded(repo, specPath).names_that_resolved).toEqual(["packages/queue/retry.ts"]);
  });

  it("judges no name at all on a record approved before the baseline existed", () => {
    // Such a record has nothing saying which of these the repository ever had,
    // so neither direction is evidence and every name is said rather than
    // guessed at — the same reading an index that cannot be believed gets.
    const { repo, specPath } = repository();
    const said = namesSaid(repo, specPath);
    expect(said).toContain("was approved before the names it carries were recorded");
    expect(said).toContain("packages/queue/retry.ts");
    expect(said).toContain("@sendActivation");
    // And the bytes are judged regardless: a baseline says nothing about them.
    const before = beforeBaseline(specPath);
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    expect(check(repo, before)!.stale).toHaveLength(1);
  });

  it("says nothing where such a record's spec names nothing at all", () => {
    // Zero names is not a sentence about zero names.
    const { repo, specPath } = repository("# Activation email\n\nNew users receive one.\n");
    expect(check(repo, beforeBaseline(specPath))).toEqual({
      path: SPEC_PATH,
      judged_against: "approval",
      stale: [],
      unjudged: [],
    });
  });
});

describe("a spec naming an @Symbol", () => {
  it("is stale once the export is removed, committed and reindexed", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    git(repo, "commit", "-qam", "rename the sender");
    index(repo);
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([
      `${SPEC_PATH} names @sendActivation, which nothing in the repository exports`,
    ]);
    expect(answer.unjudged).toEqual([]);
  });

  it("does not read a package name or an address as a symbol", () => {
    // `@perbo/queue` is a package and `ops@example.invalid` an address. Both
    // would be symbols nothing exports, and both would be wrong.
    const { repo, specPath } = repository(
      SPEC.replace("@sendActivation", "@perbo/queue, owned by ops@example.invalid,"),
    );
    expect(check(repo, recorded(repo, specPath))!.stale).toEqual([]);
    const said = namesSaid(repo, specPath);
    expect(said).not.toContain("@perbo");
    expect(said).not.toContain("@example");
  });

  it("does not read a decorator, a handle inside a URL, or a name inside a fence", () => {
    // None of the three is the spec saying this repository exports something.
    // A decorator is an external package's; a handle is part of a URL; and a
    // fence holds code, which is either somebody else's or the shape of what
    // this ticket is about to write.
    const { repo, specPath } = repository(
      SPEC.replace(
        "The queue package already has a sender.",
        "Handlers are marked @Injectable() — see https://github.com/@someuser for the\n" +
          "pattern. The shape to write:\n\n" +
          "```ts\n" +
          "@Decorate\n" +
          "export class Sender {}\n" +
          "```\n",
      ),
    );
    const said = namesSaid(repo, specPath);
    for (const name of ["@Injectable", "@someuser", "@Decorate"]) expect(said, name).not.toContain(name);
    expect(said).toContain("@sendActivation");
  });

  it("is not judged where the index is not this tree's, and says which tree it is", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    // The commit moves, and the index is left at the one before it.
    git(repo, "commit", "-qam", "rename the sender");
    const moved = check(repo, before)!;
    expect(moved.stale).toEqual([]);
    expect(moved.unjudged).toHaveLength(1);
    expect(moved.unjudged[0]).toContain("rebuild it with perbo index");
    expect(moved.unjudged[0]).toContain(git(repo, "rev-parse", "HEAD").trim().slice(0, 7));
  });

  it("is not judged where the checkout carries changes the index was not built over", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    // The index is this commit's and clean; the checkout is not.
    appendFileSync(join(repo, "packages", "queue", "retry.ts"), "export const backoff = 2;\n");
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toEqual([
      "this checkout carries uncommitted changes the symbol index was not built over, so the " +
        "symbols this spec names are not judged: rebuild it with perbo index",
    ]);
  });

  it("is not judged where the index itself was built over uncommitted changes", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    index(repo);
    // Put back, so this reaches the clause it is about rather than one of the
    // other two: HEAD has not moved and the checkout is clean, and the only
    // thing wrong is that the record read a tree nobody can name now.
    git(repo, "checkout", "--", "packages/queue/send.ts");
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toEqual([
      "the symbol index was built over uncommitted changes, so the symbols this spec names " +
        "are not judged: commit them and rebuild it with perbo index",
    ]);
  });

  it("is not judged where the directory the record names is not a git checkout", () => {
    // A store carried to another machine can name a directory that exists and
    // is not a repository: git cannot say what commit it is at, so the index
    // beside it is evidence about nothing.
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    const loose = join(scratch, `loose-${repos++}`);
    mkdirSync(join(loose, "specs", "activation-email"), { recursive: true });
    mkdirSync(join(loose, ".perbo"), { recursive: true });
    mkdirSync(join(loose, "packages", "queue"), { recursive: true });
    copyFileSync(specPath, join(loose, "specs", "activation-email", "spec.md"));
    copyFileSync(join(repo, "packages", "queue", "retry.ts"), join(loose, "packages", "queue", "retry.ts"));
    copyFileSync(join(repo, ".perbo", "index.json"), join(loose, ".perbo", "index.json"));
    const answer = check(loose, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain(`the checkout at ${loose} cannot be read`);
  });

  it("is not judged where no index has been built", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    rmSync(join(repo, ".perbo"), { recursive: true, force: true });
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain("build it with perbo index");
  });

  it("says in one sentence what an index that is not a record could not be read as", () => {
    // Whatever refused the file, the reading is one line beside a ticket. A
    // schema failure's own message is many, and a multi-line reason would
    // break the column `perbo inspect` prints it in.
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(join(repo, ".perbo", "index.json"), '{"schema_version":1}\n');
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).not.toContain("\n");
    expect(answer.unjudged[0]).toContain("could not be read");
  });

  it("reads no index at all for a spec whose symbols are none of its baseline", () => {
    // A spec naming no symbol the repository had has nothing to ask the index
    // about, and must not report "the symbols this spec names are not judged"
    // about no symbols — which is what an unbuilt index would otherwise say,
    // as a warning on every run of a ticket whose spec names only paths.
    const { repo, specPath } = repository(SPEC.replace("@sendActivation", "the queue"));
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts"]);
    rmSync(join(repo, ".perbo"), { recursive: true, force: true });
    expect(check(repo, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  });

  it("says nothing at all where the index skipped a file and no name is gone", () => {
    // The skipped list is a reason not to trust an absence, not a reason to
    // say something. A file over the megabyte is the ordinary state of a real
    // checkout, so a sentence here about no names at all would ride every run
    // of every ticket in that repository as a warning naming nothing.
    const { repo, specPath } = repository(SPEC, {
      "packages/queue/generated.ts": `// ${"x".repeat(1024 * 1024)}\n`,
    });
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["packages/queue/retry.ts", "@sendActivation"]);
    expect(readIndex(repo).skipped.map((file) => file.path)).toContain("packages/queue/generated.ts");
    expect(check(repo, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  });

  it("is not called gone on an index that skipped a file the name could be in", () => {
    const { repo, specPath } = repository();
    const before = recorded(repo, specPath);
    writeFileSync(join(repo, "packages", "queue", "send.ts"), "export function send(): number {\n  return 1;\n}\n");
    // A tracked file the index records as skipped: over the megabyte it reads.
    writeFileSync(join(repo, "packages", "queue", "generated.ts"), `// ${"x".repeat(1024 * 1024)}\n`);
    // Named rather than `-A`: the index itself lives under `.perbo`, and
    // committing that would make every later rebuild a dirty checkout.
    git(repo, "add", "packages/queue/generated.ts", "packages/queue/send.ts");
    git(repo, "commit", "-qm", "rename the sender and generate a large file");
    index(repo);
    const answer = check(repo, before)!;
    expect(answer.stale).toEqual([]);
    expect(answer.unjudged).toHaveLength(1);
    expect(answer.unjudged[0]).toContain("@sendActivation");
    expect(answer.unjudged[0]).toContain("packages/queue/generated.ts");
    expect(answer.unjudged[0]).toContain("nothing here says the name is gone");
  }, CHECKOUT_TEST_TIMEOUT_MS);
});

/**
 * One invariant over every spelling, rather than a test per spelling: a path is
 * judged after it resolves, and a spelling that resolves to a file inside this
 * repository is not stale however it is written.
 *
 * The spellings arrive two ways, because both are inputs: named inside the
 * spec's own text, and recorded as the spec's own path on a ticket file the
 * program wrote.
 */
describe("a path is judged where it lands, not where it is spelled", () => {
  const inside = [
    "packages/queue/retry.ts",
    "./packages/queue/retry.ts",
    "packages/queue/../queue/retry.ts",
    "specs/../packages/queue/retry.ts",
    "packages\\queue\\retry.ts",
  ];

  /**
   * A checkout whose `docs/link.ts` is a link out and whose `docs/away` is a
   * link to the directory that link lands in: the last segment and a middle
   * segment, both leaving the repository. The links are untracked, which
   * `perbo index` and the checkout's own cleanliness both ignore, so the
   * index beside them is still this commit's.
   */
  function linked(spec: string): { repo: string; specPath: string } {
    const { repo, specPath } = repository(spec);
    const away = mkdtempSync(join(scratch, "away-"));
    writeFileSync(join(away, "outside.ts"), "export const outside = 1;\n");
    mkdirSync(join(repo, "docs"));
    symlinkSync(join(away, "outside.ts"), join(repo, "docs", "link.ts"));
    symlinkSync(away, join(repo, "docs", "away"));
    return { repo, specPath };
  }

  // One case per spelling: each builds a checkout and runs `perbo index`, and
  // all five together ran past the 5s budget under load. The invariant is the
  // one stated above `inside` — a path is judged where it lands, not as it is
  // written — and these are what drive it.
  it.each(inside)("takes %s as a file this repository holds", (spelling) => {
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", spelling));
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved, spelling).toContain(spelling);
    expect(check(repo, before)!.stale, spelling).toEqual([]);
  });

  it("takes an absolute path into this repository as held", () => {
    // The scratch directory is reached through a link on this platform, so an
    // absolute path into the checkout is spelled one way and lands another:
    // only a check that resolves both sides reads these two apart. The path
    // cannot be written until the checkout exists, so the spec is rewritten
    // and committed rather than handed to `repository`.
    const { repo, specPath } = repository();
    const spelling = join(repo, "packages", "queue", "retry.ts");
    writeFileSync(specPath, SPEC.replace("packages/queue/retry.ts", spelling));
    git(repo, "commit", "-qam", "spell the path absolutely");
    index(repo);
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual([spelling, "@sendActivation"]);
    expect(check(repo, before)!.stale).toEqual([]);
  }, CHECKOUT_TEST_TIMEOUT_MS);

  /**
   * A name that was never this repository's cannot be one it has lost, so none
   * of these may reach the baseline — and a reading that judged the spelling
   * rather than where it lands would put the last two there.
   *
   * One case per spelling, because each builds a checkout and runs `perbo
   * index`: all four in one case, plus the repository they point away from,
   * ran past the 5s budget under load. The invariant is stated once here; the
   * cases are what drive it.
   */
  let away: string | null = null;
  const outside = (): string => {
    away ??= repository().repo;
    return join(away, "packages", "queue", "retry.ts");
  };

  it.each([
    ["an absolute path in another checkout", outside],
    ["a climb out and back down", () => "packages/../../outside.ts"],
    ["a link at the last segment", () => "docs/link.ts"],
    ["a link at a middle one", () => "docs/away/outside.ts"],
  ])("records nothing for %s", (_what, spell) => {
    const spelling = spell();
    const { repo, specPath } = linked(SPEC.replace("packages/queue/retry.ts", spelling));
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved, spelling).toEqual(["@sendActivation"]);
    expect(check(repo, before)!.stale, spelling).toEqual([]);
  });

  it("records nothing for a path git does not track, however real the file is", () => {
    // A build output is in this checkout and in no clone of the repository.
    // Recorded, the baseline travels to a clone that never had the file and
    // has it read the spec as one that has lost a path — a ticket off the
    // queue for a name that was never the repository's.
    const { repo, specPath } = repository(
      SPEC.replace("packages/queue/retry.ts", "apps/cli/dist/reader.js"),
    );
    mkdirSync(join(repo, "apps", "cli", "dist"), { recursive: true });
    writeFileSync(join(repo, "apps", "cli", "dist", "reader.js"), "export const read = 1;\n");
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["@sendActivation"]);

    // The clone is the reading that would have cost the ticket: same record,
    // same spec bytes, and none of this machine's untracked files.
    const clone = join(scratch, `clone-${repos++}`);
    execFileSync("git", ["clone", "-q", repo, clone], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
    index(clone);
    expect(check(clone, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  });

  /**
   * The same question for a link, and the case the two symlink tests above
   * cannot reach: both of theirs are **tracked**, and git carries a tracked
   * link into every clone, so a name reached through one is a name the
   * repository really has. An untracked one exists on this machine alone.
   *
   * This is what keeps the name mapped to git's spelling lexically rather than
   * through `realpath`. Resolving through the link would record
   * `docs/tmp/retry.ts` — because the file it points at is tracked — and a
   * clone that never had the link would then read the spec as one that has lost
   * a path, which is the false-stale this rule exists to close.
   */
  it("records nothing for a path reached through a link git does not track", () => {
    const { repo, specPath } = repository(
      SPEC.replace("packages/queue/retry.ts", "docs/tmp/retry.ts"),
    );
    mkdirSync(join(repo, "docs"), { recursive: true });
    symlinkSync(join(repo, "packages", "queue"), join(repo, "docs", "tmp"));
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toEqual(["@sendActivation"]);

    const clone = join(scratch, `clone-${repos++}`);
    execFileSync("git", ["clone", "-q", repo, clone], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
    index(clone);
    expect(check(clone, before)).toEqual({ path: SPEC_PATH, judged_against: "approval", stale: [], unjudged: [] });
  }, CHECKOUT_TEST_TIMEOUT_MS);

  /**
   * A spec is Markdown, and bolding the path under discussion is an ordinary
   * way to write one. The emphasis is not part of the name, so a spec that
   * writes `**packages/queue/retry.ts**` names the same file as one that writes
   * it plain — and if it is dropped here, that file's deletion is a lost file
   * nobody is told about.
   *
   * A glob is kept out by the charset a path token has to be spelled in, not
   * by anything about the emphasis. What the emphasis reading decides is where
   * the run ends, which is the second case below.
   */
  // One repository per spelling, and each builds a checkout and runs `perbo
  // index`, which is why this is `it.each` rather than one case covering every
  // spelling: bundling them into one case costs more of vitest's 5s budget
  // than a single spelling does, and more again once the machine carries any
  // load. The spellings that end a sentence are here because the trailing
  // stop is taken off first — taking the emphasis off first would leave a run
  // that no longer ends the token, and the path would be dropped.
  it.each([
    "**packages/queue/retry.ts**",
    "*packages/queue/retry.ts*",
    "_packages/queue/retry.ts_",
    "**packages/queue/retry.ts**.",
    "**packages/queue/retry.ts**:",
    "*packages/queue/retry.ts*.",
    "_packages/queue/retry.ts_.",
  ])("reads a path a spec writes as %s", (written) => {
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", written));
    expect(recorded(repo, specPath).names_that_resolved).toContain("packages/queue/retry.ts");
  });

  it("still keeps out a glob, however it is emphasised", () => {
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", "**packages/*/retry.ts**"));
    expect(recorded(repo, specPath).names_that_resolved).toEqual(["@sendActivation"]);
  });

  it("takes only the run it opened with, so a leading _ in a real name survives", () => {
    // What matching the close to the open decides, and the only thing it does.
    // `**_internal/retry.ts**` opens with three characters emphasis could be
    // written in and closes with two; taking any run at either end reads it as
    // `internal/retry.ts`, which this repository does not have — so a real
    // file's deletion becomes a lost file nobody is told about.
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", "**_internal/retry.ts**"), {
      "_internal/retry.ts": "export const retries = 3;\n",
    });
    expect(recorded(repo, specPath).names_that_resolved).toEqual(["_internal/retry.ts", "@sendActivation"]);
  });

  it("records nothing for a tracked path that lands outside the repository", () => {
    // Tracked and resolved are two questions, and a committed link out of the
    // checkout answers them differently: git has the name, and the bytes under
    // it are somebody else's.
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", "docs/away.ts"));
    const away = mkdtempSync(join(scratch, "away-"));
    writeFileSync(join(away, "outside.ts"), "export const outside = 1;\n");
    mkdirSync(join(repo, "docs"));
    symlinkSync(join(away, "outside.ts"), join(repo, "docs", "away.ts"));
    git(repo, "add", "docs/away.ts");
    git(repo, "commit", "-qm", "link to somebody else's tree");
    index(repo);
    expect(git(repo, "ls-files", "docs/away.ts").trim()).toBe("docs/away.ts");
    expect(recorded(repo, specPath).names_that_resolved).toEqual(["@sendActivation"]);
  });

  it("is stale where a path this repository had has gone, or now lands outside it", () => {
    const gone = repository(SPEC.replace("packages/queue/retry.ts", "packages/queue/policy.ts"), {
      "packages/queue/policy.ts": "export const policy = 1;\n",
    });
    const beforeGone = recorded(gone.repo, gone.specPath);
    rmSync(join(gone.repo, "packages", "queue", "policy.ts"));
    expect(check(gone.repo, beforeGone)!.stale).toEqual([
      `${SPEC_PATH} names packages/queue/policy.ts, which is not in the repository`,
    ]);

    // The same file, still spelled the same and still there — as a link to
    // somebody else's tree. The bytes the repository has are no longer its own.
    const moved = repository(SPEC.replace("packages/queue/retry.ts", "packages/queue/policy.ts"), {
      "packages/queue/policy.ts": "export const policy = 1;\n",
    });
    const beforeMoved = recorded(moved.repo, moved.specPath);
    const away = mkdtempSync(join(scratch, "away-"));
    writeFileSync(join(away, "policy.ts"), "export const policy = 2;\n");
    unlinkSync(join(moved.repo, "packages", "queue", "policy.ts"));
    symlinkSync(join(away, "policy.ts"), join(moved.repo, "packages", "queue", "policy.ts"));
    const answer = check(moved.repo, beforeMoved)!;
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("outside the repository");
    expect(answer.stale[0]).toContain(join(away, "policy.ts"));
  }, CHECKOUT_TEST_TIMEOUT_MS);

  it("judges a drive-letter spelling against this repository and not the process's directory", () => {
    // `C:/y.ts` is absolute on Windows and an ordinary directory name here.
    // Calling it absolute on every platform hands it to `realpath` unresolved,
    // which answers about whatever directory the CLI was started in — a
    // checkout-independent answer from the one function whose whole job is
    // resolving against this checkout.
    const { repo, specPath } = repository(SPEC.replace("packages/queue/retry.ts", "C:/y.ts"), {
      "C:/y.ts": "export const y = 1;\n",
    });
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toContain("C:/y.ts");
    rmSync(join(repo, "C:"), { recursive: true });
    expect(check(repo, before)!.stale).toEqual([`${SPEC_PATH} names C:/y.ts, which is not in the repository`]);
  });

  it("reads a path that ends a sentence", () => {
    // A spec writes paths in prose, and prose has full stops. Keeping the
    // punctuation makes the token fail the extension rule, and the file the
    // repository has lost is then silently not judged at all.
    const { repo, specPath } = repository(
      SPEC.replace("The queue package already has a sender.", "The policy lives in packages/queue/policy.ts."),
      { "packages/queue/policy.ts": "export const policy = 1;\n" },
    );
    const before = recorded(repo, specPath);
    expect(before.names_that_resolved).toContain("packages/queue/policy.ts");
    rmSync(join(repo, "packages", "queue", "policy.ts"));
    expect(check(repo, before)!.stale).toEqual([
      `${SPEC_PATH} names packages/queue/policy.ts, which is not in the repository`,
    ]);
  });

  it("does not read a glob or a URL as a path", () => {
    // `packages/queue/*.ts` is spelled like a file this repository does not
    // have, and is a set of files it does; the URL names nothing here at all.
    // The literal file is what makes the difference visible: without the
    // charset rule the glob would be read as the file sitting at that name.
    const { repo, specPath } = repository(
      SPEC.replace("`packages/queue/retry.ts`", "`packages/queue/*.ts` and https://example.invalid/gone.ts"),
      { "packages/queue/*.ts": "export const all = 1;\n" },
    );
    expect(check(repo, recorded(repo, specPath))!.stale).toEqual([]);
    const said = namesSaid(repo, specPath);
    expect(said).not.toContain("*.ts");
    expect(said).not.toContain("example.invalid");
  });

  it("judges the spec's own recorded path the same way, whatever the record spells", () => {
    const { repo, specPath } = repository();
    const bytes = hashOf(specPath);
    for (const spelling of [SPEC_PATH, "specs/./activation-email/spec.md", "specs\\activation-email\\spec.md"]) {
      expect(check(repo, { ...recorded(repo, specPath), path: spelling })!.stale, spelling).toEqual([]);
    }
    // A record naming a file outside the checkout is a record about another
    // machine's spec, and this checkout's spec is not it.
    const elsewhere = repository();
    const answer = check(repo, { path: elsewhere.specPath, content_sha256: bytes, names_that_resolved: [] })!;
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("outside the repository");
    expect(answer.stale[0]).toContain("which the contract was drafted from");
  }, CHECKOUT_TEST_TIMEOUT_MS);

  it("reads the spec through a link at its last segment where that link stays inside", () => {
    const { repo, specPath } = repository();
    mkdirSync(join(repo, "docs"), { recursive: true });
    symlinkSync(specPath, join(repo, "docs", "spec.md"));
    const before = recorded(repo, specPath, "docs/spec.md");
    expect(check(repo, before)!.stale).toEqual([]);
    // The bytes the link lands on are the ones judged: editing the spec it
    // points at makes the record's hash wrong under the link's own name too.
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const answer = check(repo, before)!;
    expect(answer.stale).toHaveLength(1);
    expect(answer.stale[0]).toContain("has been edited since the contract was approved from it");
  });
});
