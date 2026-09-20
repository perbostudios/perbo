import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import {
  READ_FILE_TOOL,
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";
import { UsageError } from "../src/usage-error.js";
import { parseAdmitArgs, readTicket, runAdmitCommand, storeDir } from "../src/admit.js";
import type { Streams } from "../src/streams.js";
import { nextKey, readDraftSnapshot } from "../src/tickets.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-admit-draft-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

let repos = 0;
function repository(): string {
  const dir = join(scratch, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitIdentity });
  return dir;
}

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    isTTY: false,
  };
}

const issue = {
  reference: "o/r#412",
  number: 412,
  title: "Activation emails: send, confirm, report",
  body: "Signups get no email, the link does nothing, and the report never counts them.",
  url: "https://github.com/o/r/issues/412",
};
const fetchIssue = () => Promise.resolve(issue);

/** A drafter that answers each turn from a script, recording what it was asked. */
function scripted(script: Array<Array<{ tool: string; input: unknown }>>): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    requests,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      requests.push(request);
      const calls = script[turn] ?? [];
      turn += 1;
      return {
        toolCalls: calls.map((call, index) => ({ id: `t${turn}_${index}`, name: call.tool, input: call.input })),
        usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}
const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];

const criteria = (what: string) => [
  { text: `${what} is done.`, assertion: `a test proves ${what}`, kind: "test" },
  { text: `${what} is documented.`, assertion: `docs name ${what}`, kind: "artifact" },
];

/** Work across three packages, as one contract. */
const whole = {
  outcome: "Signup sends, confirms and reports the activation email.",
  acceptance_criteria: criteria("the whole"),
  proposed_scope: { paths_allowed: ["packages/auth/**", "packages/queue/**", "packages/reports/**"], paths_prohibited_extra: [] },
  rationale: "Three packages, one piece of work.",
  depends_on: [],
};

/** The same work answered as three child contracts, each meant to become its own ticket. */
const split = {
  ...whole,
  children: [
    {
      outcome: "Signup queues one activation email.",
      acceptance_criteria: criteria("queueing"),
      proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
      depends_on_children: [],
      rationale: "The queue first.",
    },
    {
      outcome: "The activation link confirms the account.",
      acceptance_criteria: criteria("confirming"),
      proposed_scope: { paths_allowed: ["packages/auth/**"], paths_prohibited_extra: ["packages/billing/**"] },
      depends_on_children: [0],
      rationale: "Needs the email to exist.",
    },
    {
      outcome: "The daily report counts activations.",
      acceptance_criteria: criteria("reporting"),
      proposed_scope: { paths_allowed: ["packages/reports/**"], paths_prohibited_extra: [] },
      depends_on_children: [0, 1],
      rationale: "Counts both.",
    },
  ],
};

const one = {
  outcome: "New users receive an activation email.",
  acceptance_criteria: criteria("the email"),
  proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
  rationale: "Queue owns delivery.",
};

async function admitFrom(repo: string, model: Model, extra: string[] = []) {
  const streams = capture();
  const code = await runAdmitCommand({
    args: parseAdmitArgs(["--repo", repo, "--from", "o/r#412", ...extra]),
    streams,
    cwd: repo,
    model,
    fetchIssue,
  });
  return { code, streams };
}

function admittedTyped(repo: string, outcome: string, path: string): string {
  const streams = capture();
  const code = runAdmitCommand({
    args: parseAdmitArgs([
      "--repo", repo, "--outcome", outcome, "--criterion", `${outcome} :: a test asserts it`,
      "--path", path, "--approve", "--json",
    ]),
    streams,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(streams.err.join(""));
  return (JSON.parse(streams.out.join("")) as { ticket: { key: string } }).ticket.key;
}

describe("perbo admit --from: one draft is one ticket", () => {
  it("refuses a draft that splits the work into children, writes nothing, and admits the whole as one ticket", async () => {
    const repo = repository();
    const dir = storeDir(repo, null);
    const refused: unknown = await admitFrom(repo, scripted([submits(split)])).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("children");
    expect(existsSync(join(dir, "tickets", "PRB-1.json"))).toBe(false);
    expect(nextKey(dir, "PRB")).toBe("PRB-1");

    // However many packages it spans, the work drafted as one contract is one ticket.
    const { code, streams } = await admitFrom(repo, scripted([submits(whole)]), ["--json"]);
    expect(code).toBe(EXIT_CODES.approve);
    const document = JSON.parse(streams.out.join("")) as { ticket: { key: string } };
    expect(document.ticket.key).toBe("PRB-1");
    expect(readTicket(dir, "PRB-1").title).toBe(whole.outcome);
    expect(existsSync(join(dir, "tickets", "PRB-2.json"))).toBe(false);
  });

  it("steps over an in-flight ticket whose contract is missing, and names it on stderr", async () => {
    const repo = repository();
    const first = admittedTyped(repo, "Docs say what is true.", "docs/**");
    const dir = storeDir(repo, null);
    unlinkSync(join(dir, "tickets", `${first}.contract.json`));
    const model = scripted([submits(one)]);
    const { code, streams } = await admitFrom(repo, model);
    expect(code).toBe(EXIT_CODES.approve);
    expect(JSON.stringify(model.requests[0]?.messages[0])).not.toContain(first);
    expect(streams.err.join("")).toContain(`${first} is in flight but its contract cannot be read; it is left off the board`);
    expect(readTicket(dir, "PRB-2").title).toBe(one.outcome);
  });

  it("shows the drafter the board, takes the dependency it proposes, and refuses one the board does not show", async () => {
    const repo = repository();
    const first = admittedTyped(repo, "Docs say what is true.", "docs/**");
    const model = scripted([submits({ ...one, depends_on: [first] })]);
    const { code } = await admitFrom(repo, model);
    expect(code).toBe(EXIT_CODES.approve);
    const shown = JSON.stringify(model.requests[0]?.messages[0]);
    expect(shown).toContain("<perbo:board");
    expect(shown).toContain(first);
    expect(shown).toContain("docs/**");
    const dir = storeDir(repo, null);
    expect(readTicket(dir, "PRB-2").depends_on).toEqual([first]);

    // Typed wins over proposed.
    await admitFrom(repo, scripted([submits({ ...one, depends_on: [first] })]), ["--depends-on", "PRB-2"]);
    expect(readTicket(dir, "PRB-3").depends_on).toEqual(["PRB-2"]);

    // A key nobody holds is refused on the way in, and nothing is written.
    await expect(admitFrom(repo, scripted([submits({ ...one, depends_on: ["PRB-99"] })]))).rejects.toThrow(UsageError);
    await expect(admitFrom(repo, scripted([submits({ ...one, depends_on: ["PRB-99"] })]))).rejects.toThrow(/PRB-99 not on the board/);
    expect(existsSync(join(dir, "tickets", "PRB-4.json"))).toBe(false);
  });

  it("lets the drafter open a few files, and records each read and each refusal on the snapshot", async () => {
    const repo = repository();
    writeFileSync(join(repo, "README.md"), "# hello\n");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const model = scripted([
      [
        { tool: READ_FILE_TOOL, input: { path: "README.md" } },
        { tool: READ_FILE_TOOL, input: { path: ".env" } },
      ],
      submits(one),
    ]);
    const { code } = await admitFrom(repo, model);
    expect(code).toBe(EXIT_CODES.approve);
    expect(model.requests).toHaveLength(2);
    // The second turn carried the file back, and the refusal in the reader's words.
    const second = JSON.stringify(model.requests[1]?.messages);
    expect(second).toContain("# hello");
    expect(second).toContain("secret");
    const snapshot = readDraftSnapshot(storeDir(repo, null), "PRB-1");
    expect(snapshot?.draft?.files_read).toEqual([
      { path: "README.md", bytes: 8, refused: null },
      { path: ".env", bytes: 0, refused: expect.stringContaining("secret") },
    ]);
  });
});
