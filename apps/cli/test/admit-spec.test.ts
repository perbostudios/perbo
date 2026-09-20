import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ApproachRecordSchema, EXIT_CODES } from "@perbo/contracts";
import {
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";
import { UsageError } from "../src/args.js";
import { parseAdmitArgs, runAdmitCommand, type Streams } from "../src/admit.js";
import { runEditCommand } from "../src/edit.js";
import { INTERVIEW_SESSION_FILE } from "../src/interview.js";
import { specCommitFiles } from "../src/specs.js";
import { readApproachRecord, readContract, readDraftSnapshot, readTicket, storeDir } from "../src/tickets.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-admit-spec-test-"));
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

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A duplicate signup inside five minutes queues nothing.
- R4: A failed send is retried three times.

## No-Gos

- Nothing is sent to an address that has unsubscribed.
- No change to the signup form.

## Notes

The queue package already has a sender.
`;

let repos = 0;
function repository(spec = SPEC): { repo: string; specPath: string } {
  const repo = join(scratch, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, "specs", "activation-email"), { recursive: true });
  const specPath = join(repo, "specs", "activation-email", "spec.md");
  writeFileSync(specPath, spec);
  mkdirSync(join(repo, "packages", "queue"), { recursive: true });
  writeFileSync(join(repo, "packages", "queue", "send.ts"), "export const send = () => 1;\n");
  mkdirSync(join(repo, "packages", "auth"), { recursive: true });
  writeFileSync(join(repo, "packages", "auth", "signup.ts"), "export const signup = () => 1;\n");
  writeFileSync(join(repo, "CONTEXT.md"), "# Terms\n\nA signup is a person asking for an account.\n");
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  writeFileSync(join(repo, "docs", "adr", "0001-queue.md"), "# ADR-0001: A queue\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: gitIdentity });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitIdentity });
  return { repo, specPath };
}

/** The SHA-256 of a file as the admission record states it. */
const hashOf = (path: string) =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

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

function scripted(script: Array<Array<{ tool: string; input: unknown }>>): Model & {
  requests: ModelRequest[];
} {
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
        toolCalls: calls.map((call, index) => ({
          id: `t${turn}_${index}`,
          name: call.tool,
          input: call.input,
        })),
        usage: {
          input_tokens: 800,
          output_tokens: 150,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}
const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];

const drafted = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues exactly one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
      requirement_id: "R1",
    },
    {
      text: "A duplicate signup inside five minutes queues nothing.",
      assertion: "a second signup inside the window queues nothing",
      kind: "test",
      requirement_id: "R2",
    },
    {
      text: "A failed send is retried three times.",
      assertion: "three attempts are recorded for one failing send",
      kind: "test",
      requirement_id: "R4",
    },
  ],
  proposed_scope: {
    paths_allowed: ["packages/queue/**", "packages/auth/**"],
    paths_prohibited_extra: [],
  },
  rationale: "The spec's three requirements fall into queueing and retrying.",
  depends_on: [],
  nodes: [
    { title: "Queue the email", criteria: [0, 1], paths: ["packages/queue/**"] },
    { title: "Retry a failed send", criteria: [2], paths: ["packages/queue/**"] },
  ],
  edges: [{ from: 0, to: 1 }],
};

async function admitFromSpec(
  repo: string,
  specPath: string,
  model: Model,
  extra: string[] = [],
) {
  const streams = capture();
  const code = await runAdmitCommand({
    args: parseAdmitArgs(["--repo", repo, "--from-spec", specPath, ...extra]),
    streams,
    cwd: repo,
    model,
  });
  return { code, streams };
}

/** An "editor" that is `node <script>`, writing one citation into the contract as a hand edit does. */
function citing(name: string, criterion: number, requirementId: string): string {
  const script = join(scratch, `${name}.js`);
  writeFileSync(
    script,
    `const fs = require("node:fs");\nconst file = process.argv[process.argv.length - 1];\n` +
      `const c = JSON.parse(fs.readFileSync(file, "utf8"));\n` +
      `c.acceptance_criteria[${criterion}].requirement_id = ${JSON.stringify(requirementId)};\n` +
      `fs.writeFileSync(file, JSON.stringify(c, null, 2));\n`,
  );
  return `node ${script}`;
}
const editWith = (repo: string, editor: string) =>
  runEditCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, env: { EDITOR: editor } });

describe("a citation on a spec-drafted contract is checked against the spec", () => {
  it("accepts an id the spec carries, refuses one it does not, and names a spec it cannot read", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const dir = storeDir(repo, null);
    // R4 is in the spec, cited by ac_3 but not by ac_1: a criterion may start citing it.
    expect(await editWith(repo, citing("cite-r4", 0, "R4"))).toBe(EXIT_CODES.approve);
    const contract = readContract(dir, "PRB-1");
    expect(
      "acceptance_criteria" in contract ? contract.acceptance_criteria[0]?.requirement_id : null,
    ).toBe("R4");
    // R9 is not in the spec, whatever the file says.
    await expect(editWith(repo, citing("cite-r9", 1, "R9"))).rejects.toThrow(/R9/);
    // The spec is what the set is read from; without it nothing can be checked.
    rmSync(specPath);
    await expect(editWith(repo, citing("cite-r2", 1, "R2"))).rejects.toThrow(
      /specs\/activation-email\/spec\.md/,
    );
  });
});

describe("a citation an undo would put back is checked against the spec", () => {
  it("refuses the undo while the spec no longer carries the id, and applies it once it does", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const dir = storeDir(repo, null);
    const graphEdit = (edits: unknown) =>
      runEditCommand({
        argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edits)],
        streams: capture(),
        cwd: repo,
      });
    const cited = () => {
      const contract = readContract(dir, "PRB-1");
      return "acceptance_criteria" in contract
        ? contract.acceptance_criteria.map((criterion) => criterion.requirement_id ?? null)
        : [];
    };
    // Edit 1 records ac_1 whole, citing R1; the spec then renames R1 to R3,
    // and the person takes the remedy the next edit offers: drop the citation.
    expect(
      await graphEdit({
        op: "set_criterion",
        id: "ac_1",
        text: "A signup queues one activation email.",
        expected_verification: { kind: "test", assertion: "one message is on the queue" },
      }),
    ).toBe(EXIT_CODES.approve);
    writeFileSync(specPath, SPEC.replace("- R1:", "- R3:"));
    const dropping = join(scratch, "drop-r1.js");
    writeFileSync(
      dropping,
      `const fs = require("node:fs");\nconst file = process.argv[process.argv.length - 1];\n` +
        `const c = JSON.parse(fs.readFileSync(file, "utf8"));\ndelete c.acceptance_criteria[0].requirement_id;\n` +
        `fs.writeFileSync(file, JSON.stringify(c, null, 2));\n`,
    );
    expect(await editWith(repo, `node ${dropping}`)).toBe(EXIT_CODES.approve);
    expect(cited()).toEqual([null, "R2", "R4"]);

    const undo = () =>
      runEditCommand({ argv: ["PRB-1", "--repo", repo, "--undo", "1"], streams: capture(), cwd: repo });
    await expect(undo()).rejects.toThrow(/R1/);
    expect(cited()).toEqual([null, "R2", "R4"]);
    expect(readDraftSnapshot(dir, "PRB-1")?.edits.map((edit) => edit.undone)).toEqual([false, false]);

    writeFileSync(specPath, SPEC);
    expect(await undo()).toBe(EXIT_CODES.approve);
    expect(cited()).toEqual(["R1", "R2", "R4"]);
  });
});

describe("a spec's No-Gos outlive a graph a hand edit drops", () => {
  it("keeps the approach record for the No-Gos, with no edges, when the plan is ungrouped without its draft", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const dir = storeDir(repo, null);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toHaveLength(1);
    rmSync(join(dir, "tickets", "PRB-1.draft.json"));
    const script = join(scratch, "ungroup-spec.js");
    writeFileSync(
      script,
      `const fs = require("node:fs");\nconst file = process.argv[process.argv.length - 1];\n` +
        `const c = JSON.parse(fs.readFileSync(file, "utf8"));\ndelete c.nodes;\n` +
        `fs.writeFileSync(file, JSON.stringify(c, null, 2));\n`,
    );
    expect(await editWith(repo, `node ${script}`)).toBe(EXIT_CODES.approve);
    const approach = readApproachRecord(dir, "PRB-1");
    expect(approach?.edges).toEqual([]);
    expect(approach?.no_gos).toEqual([
      "Nothing is sent to an address that has unsubscribed.",
      "No change to the signup form.",
    ]);
  });
});

describe("perbo admit --from-spec", () => {
  it("admits one ticket at plan_review whose plan carries the drafted nodes", async () => {
    const { repo, specPath } = repository();
    const { code } = await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    expect(code).toBe(EXIT_CODES.approve);

    const dir = storeDir(repo, null);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("plan_review");
    expect(ticket.approved_at).toBeNull();

    const contract = readContract(dir, "PRB-1");
    expect(contract.level).not.toBe("P0");
    const nodes = (contract as { nodes?: Array<{ id: string; criteria: string[]; paths: string[] }> })
      .nodes;
    expect(nodes?.map((node) => node.id)).toEqual(["node_1", "node_2"]);
    expect(nodes?.[0]?.criteria).toEqual(["ac_1", "ac_2"]);
    expect(nodes?.[1]?.paths).toEqual(["packages/queue/**"]);
  });

  it("shows the person the graph and the No-Gos it just recorded", async () => {
    const { repo, specPath } = repository();
    const { streams } = await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const err = streams.err.join("");
    expect(err).toContain("node_1  Queue the email");
    expect(err).toContain("ac_1, ac_2");
    expect(err).toContain("node_1 -> node_2");
    expect(err).toContain("Nothing is sent to an address that has unsubscribed.");
  });

  it("records the criteria source, the spec's repository-relative path and its content hash", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const ticket = readTicket(storeDir(repo, null), "PRB-1");
    expect(ticket.admission.criteria_source).toBe("spec");
    expect(ticket.admission.spec?.path).toBe("specs/activation-email/spec.md");
    expect(ticket.admission.spec?.content_sha256).toBe(hashOf(specPath));
    expect(ticket.admission.criteria_count).toBe(3);
  });

  it("records every file the loop commits: the spec's folder, and the CONTEXT.md and ADRs changed since the last commit", async () => {
    const { repo, specPath } = repository();
    // What the interview left in the checkout: a reworded CONTEXT.md, a new
    // ADR, and an untouched one that is nobody's to commit with this ticket.
    writeFileSync(join(repo, "CONTEXT.md"), "# Terms\n\nA signup is a person asking for an account.\n\nAn activation email proves the address.\n");
    writeFileSync(join(repo, "docs", "adr", "0002-retry.md"), "# ADR-0002: Retry a failed send\n");
    // And what it left beside the spec to find its own session again, which is
    // not the statement this change is judged against and moves every session.
    writeFileSync(
      join(repo, "specs", "activation-email", INTERVIEW_SESSION_FILE),
      JSON.stringify({ session_id: "sess-1", spec: "specs/activation-email/spec.md" }),
    );
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const ticket = readTicket(storeDir(repo, null), "PRB-1");
    const files = ticket.admission.spec?.files ?? [];
    expect(files.map((file) => file.path)).toEqual([
      "specs/activation-email/spec.md",
      "specs/activation-email/nodes/node_1.md",
      "specs/activation-email/nodes/node_2.md",
      "CONTEXT.md",
      "docs/adr/0002-retry.md",
    ]);
    for (const file of files) expect(file.content_sha256).toBe(hashOf(join(repo, file.path)));
  });

  it("records the spec's folder alone where the checkout's CONTEXT.md and ADRs are as the last commit left them", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const files = readTicket(storeDir(repo, null), "PRB-1").admission.spec?.files ?? [];
    expect(files.map((file) => file.path)).toEqual([
      "specs/activation-email/spec.md",
      "specs/activation-email/nodes/node_1.md",
      "specs/activation-email/nodes/node_2.md",
    ]);
  });

  it("records the ADR folder the repository configured rather than the default", async () => {
    const { repo, specPath } = repository();
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ adr: "docs/decisions" }));
    mkdirSync(join(repo, "docs", "decisions"), { recursive: true });
    writeFileSync(join(repo, "docs", "decisions", "0002-retry.md"), "# ADR-0002: Retry a failed send\n");
    writeFileSync(join(repo, "docs", "adr", "0003-elsewhere.md"), "# ADR-0003: Not this repository's\n");
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const files = readTicket(storeDir(repo, null), "PRB-1").admission.spec?.files ?? [];
    expect(files.map((file) => file.path)).toContain("docs/decisions/0002-retry.md");
    expect(files.map((file) => file.path)).not.toContain("docs/adr/0003-elsewhere.md");
  });

  it("carries no spec record for a ticket admitted from anything else", async () => {
    const { repo } = repository();
    const streams = capture();
    const code = runAdmitCommand({
      args: parseAdmitArgs([
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it",
        "--path", "docs/**",
      ]),
      streams,
      cwd: repo,
    });
    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(storeDir(repo, null), "PRB-1");
    expect(ticket.admission.spec).toBeNull();
    expect(ticket.admission.criteria_source).toBe("typed");
  });

  it("writes the approach beside the ticket's three files, with the edges and the spec's No-Gos", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const dir = storeDir(repo, null);
    expect(existsSync(join(dir, "tickets", "PRB-1.approach.json"))).toBe(true);

    const approach = readApproachRecord(dir, "PRB-1");
    expect(approach?.edges).toEqual([{ from: "node_1", to: "node_2" }]);
    // Read from the spec's own heading, never drafted: the model never saw a
    // field for them and never returned one.
    expect(approach?.no_gos).toEqual([
      "Nothing is sent to an address that has unsubscribed.",
      "No change to the signup form.",
    ]);
    expect(ApproachRecordSchema.parse(approach).ticket_id).toBe(
      readTicket(dir, "PRB-1").ticket_id,
    );
  });

  it("writes no approach for a flat plan drafted from an issue", async () => {
    const { repo } = repository();
    const streams = capture();
    runAdmitCommand({
      args: parseAdmitArgs([
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it",
        "--path", "docs/**",
      ]),
      streams,
      cwd: repo,
    });
    expect(existsSync(join(storeDir(repo, null), "tickets", "PRB-1.approach.json"))).toBe(false);
  });

  it("writes an approach with no edges for a drafted graph the drafter suggested no order for", async () => {
    const { repo, specPath } = repository();
    const { code } = await admitFromSpec(repo, specPath, scripted([submits({ ...drafted, edges: [] })]));
    expect(code).toBe(EXIT_CODES.approve);
    const approach = readApproachRecord(storeDir(repo, null), "PRB-1");
    expect(approach?.edges).toEqual([]);
    expect(approach?.no_gos).toHaveLength(2);
    // The same with nothing else to carry: nodes alone are enough for the record.
    const bare = repository(SPEC.replace("## No-Gos\n\n- Nothing is sent to an address that has unsubscribed.\n- No change to the signup form.\n", "## No-Gos\n\n"));
    await admitFromSpec(bare.repo, bare.specPath, scripted([submits({ ...drafted, edges: [] })]));
    expect(readApproachRecord(storeDir(bare.repo, null), "PRB-1")).toEqual(
      expect.objectContaining({ edges: [], no_gos: [] }),
    );
  });

  it("writes an approach with no edges for a spec whose plan is flat but that states No-Gos", async () => {
    const { repo, specPath } = repository();
    const flat = { ...drafted, nodes: [], edges: [] };
    await admitFromSpec(repo, specPath, scripted([submits(flat)]));
    const approach = readApproachRecord(storeDir(repo, null), "PRB-1");
    expect(approach?.edges).toEqual([]);
    expect(approach?.no_gos).toHaveLength(2);
  });

  it("hands the spec to the drafter as external data, with the ids it may cite", async () => {
    const { repo, specPath } = repository();
    const model = scripted([submits(drafted)]);
    await admitFromSpec(repo, specPath, model);
    const shown = String(model.requests[0]?.messages[0]?.content);
    expect(shown).toMatch(/<perbo:spec trust="external"[^>]*>/);
    expect(shown).toContain("R1, R2, R4");
    expect(String(model.requests[0]?.system)).not.toContain("activation email within 60 seconds");
  });

  it("refuses a criterion citing a requirement the spec does not carry", async () => {
    const { repo, specPath } = repository();
    const wrong = {
      ...drafted,
      acceptance_criteria: drafted.acceptance_criteria.map((criterion, index) =>
        index === 2 ? { ...criterion, requirement_id: "R9" } : criterion,
      ),
    };
    const refused: unknown = await admitFromSpec(repo, specPath, scripted([submits(wrong)])).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("R9");
    expect(existsSync(join(storeDir(repo, null), "tickets", "PRB-1.json"))).toBe(false);
  });

  it("refuses a spec outside the repository before asking a model anything", async () => {
    const { repo } = repository();
    const outside = join(scratch, `outside-${repos}`, "spec.md");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, SPEC);
    const model = scripted([submits(drafted)]);
    await expect(admitFromSpec(repo, outside, model)).rejects.toThrow(/outside .*specs\/<slug>\/spec\.md/);
    expect(model.requests).toHaveLength(0);
    expect(existsSync(join(storeDir(repo, null), "tickets", "PRB-1.json"))).toBe(false);
  });

  it("refuses a spec whose sections are not the ones a spec has, writing nothing", async () => {
    const { repo, specPath } = repository(SPEC.replace("## No-Gos", "## No-Go"));
    const refused: unknown = await admitFromSpec(
      repo,
      specPath,
      scripted([submits(drafted)]),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("No-Go");
  });

  it("cannot be given with --from or --from-file, and cannot approve in the same command", () => {
    expect(() => parseAdmitArgs(["--from-spec", "a.md", "--from", "o/r#1"])).toThrow(UsageError);
    expect(() => parseAdmitArgs(["--from-spec", "a.md", "--from-file", "b.md"])).toThrow(UsageError);
  });

  it("lets --outcome override the drafted one, and drops the graph when the criteria are typed", async () => {
    const { repo, specPath } = repository();
    const { code, streams } = await admitFromSpec(repo, specPath, scripted([submits(drafted)]), [
      "--outcome",
      "The activation email arrives.",
      "--criterion",
      "one email is queued :: a test asserts it",
    ]);
    expect(code).toBe(EXIT_CODES.approve);
    const dir = storeDir(repo, null);
    const contract = readContract(dir, "PRB-1");
    expect(contract.outcome).toBe("The activation email arrives.");
    expect((contract as { nodes?: unknown }).nodes).toBeUndefined();
    expect(streams.err.join("")).toContain("graph");
    // The No-Gos are the spec's whatever the person typed, so the approach stays.
    expect(readApproachRecord(dir, "PRB-1")?.no_gos).toHaveLength(2);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);
  });
});

describe("a spec is one piece of work's, in a folder of its own", () => {
  it("refuses a spec that is not under the spec folder, before a model is asked", async () => {
    const { repo } = repository();
    // At the root of the repository: its folder is the repository, and the
    // loop would commit everything in it.
    const loose = join(repo, "spec.md");
    writeFileSync(loose, SPEC);
    const asked: string[] = [];
    const model: Model = {
      complete: async () => {
        asked.push("drafted");
        throw new Error("no model is asked for a spec that is not one piece of work");
      },
    } as unknown as Model;

    const refused = await admitFromSpec(repo, loose, model).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toContain("specs/<slug>/spec.md");
    expect(asked).toEqual([]);
  });

  it("refuses a spec in a folder that is not the spec folder's", async () => {
    const { repo } = repository();
    mkdirSync(join(repo, "notes"), { recursive: true });
    const elsewhere = join(repo, "notes", "spec.md");
    writeFileSync(elsewhere, SPEC);
    const refused = await admitFromSpec(repo, elsewhere, scripted([submits(drafted)])).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toContain("specs/<slug>/spec.md");
  });
});

describe("the files the loop commits with the spec", () => {
  it("says so where git cannot report what the checkout has changed", () => {
    // Not a git repository, so `git status` answers nothing about CONTEXT.md
    // and the ADR folder, and the list carries the spec's folder alone.
    const root = mkdtempSync(join(scratch, "no-git-"));
    mkdirSync(join(root, "specs", "activation-email"), { recursive: true });
    writeFileSync(join(root, "specs", "activation-email", "spec.md"), SPEC);
    writeFileSync(join(root, "CONTEXT.md"), "# Terms\n");

    const said: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      said.push(String(chunk));
      return true;
    });
    let files;
    try {
      files = specCommitFiles({
        repositoryRoot: root,
        store: join(root, ".perbo"),
        specPath: "specs/activation-email/spec.md",
      });
    } finally {
      stderr.mockRestore();
    }

    expect(files.map((file) => file.path)).toEqual(["specs/activation-email/spec.md"]);
    expect(said.join("")).toContain("CONTEXT.md");
    expect(said.join("")).toContain("warning");
  });

  it("leaves out a file git reports as deleted, which has no bytes to commit", () => {
    // `git status` reports a deleted CONTEXT.md as changed. The loop commits
    // the bytes it copies out of the checkout, and a file that is gone has
    // none: recorded, it would be read after the draft was paid for.
    const { repo } = repository();
    rmSync(join(repo, "CONTEXT.md"), { force: true });
    const files = specCommitFiles({
      repositoryRoot: repo,
      store: storeDir(repo, null),
      specPath: "specs/activation-email/spec.md",
    });
    expect(files.map((file) => file.path)).not.toContain("CONTEXT.md");
    expect(files.map((file) => file.path)).toContain("specs/activation-email/spec.md");
  });

  it("refuses a recorded spec path with no folder of its own, rather than walking the repository", () => {
    const root = mkdtempSync(join(scratch, "root-spec-"));
    writeFileSync(join(root, "spec.md"), SPEC);
    writeFileSync(join(root, "CONTEXT.md"), "# Terms\n");
    expect(() =>
      specCommitFiles({ repositoryRoot: root, store: join(root, ".perbo"), specPath: "spec.md" }),
    ).toThrow(UsageError);
  });

  it("says so where a folder under the spec cannot be read", () => {
    const root = mkdtempSync(join(scratch, "unreadable-"));
    mkdirSync(join(root, "specs", "activation-email", "nodes"), { recursive: true });
    writeFileSync(join(root, "specs", "activation-email", "spec.md"), SPEC);
    writeFileSync(join(root, "specs", "activation-email", "nodes", "node_1.md"), "# A node\n");
    const closed = join(root, "specs", "activation-email", "nodes");
    chmodSync(closed, 0o000);

    const said: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      said.push(String(chunk));
      return true;
    });
    let files;
    try {
      files = specCommitFiles({
        repositoryRoot: root,
        store: join(root, ".perbo"),
        specPath: "specs/activation-email/spec.md",
      });
    } finally {
      stderr.mockRestore();
      chmodSync(closed, 0o755);
    }

    expect(files.map((file) => file.path)).toEqual(["specs/activation-email/spec.md"]);
    expect(said.join("")).toContain("specs/activation-email/nodes");
    expect(said.join("")).toContain("warning");
  });
});
