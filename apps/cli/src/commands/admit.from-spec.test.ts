import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ApproachRecordSchema, EXIT_CODES, type AcceptanceCriterion } from "@perbo/contracts";
import {
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";
import { UsageError } from "../usage-error.js";
import { admitCommandLine, approveCommandLine } from "./admit.js";
import { editCommandLine } from "./edit/index.js";
import { INTERVIEW_SESSION_FILE } from "./interview/index.js";
import { specCommitFiles } from "../spec/pages.js";
import { readDriftRecord } from "../store/drift.js";
import { listTickets, readApproachRecord, readContract, readTicket, storeDir } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { initRepository } from "@perbo/test-support";

const scratch = mkdtempSync(join(tmpdir(), "perbo-admit-spec-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
  const specPath = join(repo, "specs", "activation-email", "spec.md");
  initRepository(repo, {
    files: {
      "specs/activation-email/spec.md": spec,
      "packages/queue/send.ts": "export const send = () => 1;\n",
      "packages/auth/signup.ts": "export const signup = () => 1;\n",
      "CONTEXT.md": "# Terms\n\nA signup is a person asking for an account.\n",
      "docs/adr/0001-queue.md": "# ADR-0001: A queue\n",
    },
  });
  return { repo, specPath };
}

/** The SHA-256 of a file as the admission record states it. */
const hashOf = (path: string) =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

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
  name: "Activation email",
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
  const streams = recordStreams();
  const code = await runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, ...extra], streams, cwd: repo, deps: { model } });
  return { code, streams };
}

/** A ticket admitted by hand, with no model, called by the outcome it was typed with. */
async function admitTyped(repo: string, outcome: string): Promise<void> {
  const code = await runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo, "--outcome", outcome, "--criterion", `${outcome} :: a test asserts it`,
      "--path", "packages/auth/**",
    ],
    streams: recordStreams(),
    cwd: repo,
  });
  expect(code).toBe(EXIT_CODES.approve);
}

/** The names the drafter was shown, one a line, from its first request. */
function namesShown(model: { requests: ModelRequest[] }): string[] {
  const user = String(model.requests[0]!.messages[0]!.content);
  const block = /<perbo:names trust="repo"[^>]*>\n([\s\S]*?)\n<\/perbo:names>/.exec(user);
  expect(block, "a names block").not.toBeNull();
  return block![1]!.split("\n");
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
const editWith = async (repo: string, editor: string) =>
  runCommandLine(editCommandLine, {
    argv: ["PRB-1", "--repo", repo],
    streams: recordStreams(),
    cwd: repo,
    deps: { env: { EDITOR: editor } },
  });
const approve = (repo: string) =>
  runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo });

const criteriaOf = (dir: string): AcceptanceCriterion[] => {
  const contract = readContract(dir, "PRB-1");
  return "acceptance_criteria" in contract ? contract.acceptance_criteria : [];
};
const asFlag = (each: AcceptanceCriterion): string =>
  `${each.text} :: ${each.expected_verification.assertion} :: ${each.expected_verification.kind}`;

/**
 * PRB-1 drafted from the spec, then flat, as deleting the last node from the
 * Graph pane leaves it: `--criterion` replaces every criterion and is refused
 * while the plan has nodes. Its nodes are merged into one and that one
 * deleted, so its criteria have nowhere to move to and every one is kept.
 */
async function admittedFlat(): Promise<{ repo: string; dir: string; was: AcceptanceCriterion[] }> {
  const { repo, specPath } = repository();
  await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
  const dir = storeDir(repo, null);
  const graphEdit = (edits: unknown) =>
    runCommandLine(editCommandLine, {
      argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edits)],
      streams: recordStreams(),
      cwd: repo,
    });
  const start = readContract(dir, "PRB-1");
  const nodes = "nodes" in start ? (start.nodes ?? []) : [];
  for (let at = 1; at < nodes.length; at += 1)
    expect(
      await graphEdit({ op: "merge_nodes", ids: [nodes[0]!.id, nodes[at]!.id] }),
      `merging ${nodes[at]!.id}`,
    ).toBe(EXIT_CODES.approve);
  expect(
    await graphEdit({ op: "delete_node", id: nodes[0]!.id, move_criteria_to: null }),
    "the last node goes and the plan is flat",
  ).toBe(EXIT_CODES.approve);
  return { repo, dir, was: criteriaOf(dir) };
}

describe("a citation on a spec-drafted contract is settled where it is frozen", () => {
  it("lets an edit write a citation the spec does not carry, and refuses to freeze it", async () => {
    // Editing is free: a citation the spec does not carry is written, and read
    // on the contract page, and refused at approval — which is where the
    // contract is frozen (D-128).
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    expect(await editWith(repo, citing("cite-r9", 1, "R9"))).toBe(EXIT_CODES.approve);
    expect(() => approve(repo)).toThrow(/R9/);
  });

  it("passes over a spec whose file has gone, as the rest of approval does", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    rmSync(specPath);
    // Nothing can be checked against a spec that is not there, and approval
    // does not refuse over it — it leaves admission's record standing.
    expect(approve(repo)).toBe(EXIT_CODES.approve);
  });
});

describe("approving settles what the plan cites against the spec", () => {
  it("refuses to freeze a contract citing a requirement the spec no longer carries", async () => {
    // Approval freezes the contract (ADR-0016) and the spec travels with it —
    // the loop commits the folder and the reviewer reads it. A citation
    // pointing at nothing would be frozen in and printed on a node's page as
    // provenance it does not have (D-103).
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    // The person edits the spec between drafting and approving, which is theirs
    // to do: R1 goes.
    writeFileSync(specPath, SPEC.replace("- R1:", "- R7:"));
    expect(() => approve(repo)).toThrow(/R1/);
  });

  it("approves where every citation still stands", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    expect(approve(repo)).toBe(EXIT_CODES.approve);
  });
});

describe("a criterion keeps the requirement it answers across an edit", () => {
  it("does not move a requirement onto a criterion that shares another's words", async () => {
    // Two criteria can say the same thing and be proven differently. If only
    // the cited one is counted, the text looks unambiguous and the requirement
    // lands on whichever copy survives — a citation that is wrong rather than
    // missing, which nothing downstream can catch.
    const { repo, dir, was } = await admittedFlat();
    const cited = was.find((each) => each.requirement_id !== undefined)!;
    // A twin: the same words, proven another way, citing nothing.
    const argv = ["PRB-1", "--repo", repo];
    for (const each of was) argv.push("--criterion", asFlag(each));
    argv.push("--criterion", `${cited.text} :: a screenshot of it :: artifact`);
    expect(
      await runCommandLine(editCommandLine, { argv, streams: recordStreams(), cwd: repo, deps: { env: {} } }),
      "the edit is written",
    ).toBe(EXIT_CODES.approve);

    // Neither twin carries the requirement: it cannot be told which of them
    // answers it, so the citation goes, visibly, rather than moving.
    const after = criteriaOf(dir);
    const twins = after.filter((each) => each.text === cited.text);
    expect(twins, "both twins are written").toHaveLength(2);
    expect(
      twins.map((each) => each.requirement_id),
      "an ambiguous text carries no citation",
    ).toEqual([undefined, undefined]);
    // And every other criterion keeps its own.
    const others = new Map(
      was.filter((each) => each.text !== cited.text).map((each) => [each.text, each.requirement_id]),
    );
    expect(others.size, "criteria beside the twins").toBeGreaterThan(0);
    for (const each of after.filter((entry) => entry.text !== cited.text))
      expect(each.requirement_id, `${each.id} keeps its own requirement`).toBe(others.get(each.text));
  });

  it("does not move a requirement onto another criterion when the order changes", async () => {
    // `parseCriterion` numbers what it is given, ac_1 upward, so neither the id
    // nor the position identifies a criterion across a flag edit: reorder them
    // and either would stamp each requirement onto its neighbour. Every id
    // still exists in the spec afterwards, so nothing downstream could catch
    // it — the citation would be wrong rather than missing.
    const { repo, dir, was } = await admittedFlat();
    expect(was.length, "more than one criterion to reorder").toBeGreaterThan(1);
    const cited = new Map(was.map((each) => [each.text, each.requirement_id]));
    expect([...cited.values()].filter(Boolean).length, "the plan cites its spec").toBeGreaterThan(1);

    // The same criteria, the same count, back to front. Nothing is dropped, so
    // the edit goes through — and every requirement must travel with its own
    // words rather than with the number it happened to hold.
    const argv = ["PRB-1", "--repo", repo];
    for (const each of [...was].reverse()) argv.push("--criterion", asFlag(each));
    expect(await runCommandLine(editCommandLine, { argv, streams: recordStreams(), cwd: repo, deps: { env: {} } })).toBe(
      EXIT_CODES.approve,
    );

    for (const each of criteriaOf(dir))
      expect(
        each.requirement_id,
        `${each.id} ("${each.text.slice(0, 28)}") must keep its own requirement`,
      ).toBe(cited.get(each.text));
  });

  it("keeps a criterion's requirement across a flag edit, which carries text and verification only", async () => {
    // The desktop's compile sends --criterion for every criterion whether it
    // changed or not. Without carrying the citation every compile would drop
    // them all, silently, and the node pages would tell the executor the work
    // was drafted from nothing (D-103).
    const { repo, dir, was } = await admittedFlat();
    const cited = was.map((each) => each.requirement_id);
    expect(cited.filter(Boolean).length, "the drafted plan cites its spec").toBeGreaterThan(0);

    // Re-send every criterion unchanged, as a compile does.
    const argv = ["PRB-1", "--repo", repo];
    for (const each of was) argv.push("--criterion", asFlag(each));
    expect(await runCommandLine(editCommandLine, { argv, streams: recordStreams(), cwd: repo, deps: { env: {} } })).toBe(
      EXIT_CODES.approve,
    );
    expect(criteriaOf(dir).map((each) => each.requirement_id)).toEqual(cited);
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
  it("refuses a second ticket from one spec, and says which one is already there", async () => {
    // One spec is one piece of work (D-103). Drafting from it again is a second
    // ticket for the same work, whose records name the same spec — and the
    // ticket being asked for is the one already drafted.
    const { repo, specPath } = repository();
    expect((await admitFromSpec(repo, specPath, scripted([submits(drafted)]))).code).toBe(
      EXIT_CODES.approve,
    );

    // Refused before a model is asked, so the second draft costs nothing.
    const model = scripted([submits(drafted)]);
    await expect(admitFromSpec(repo, specPath, model)).rejects.toThrow(UsageError);
    await expect(admitFromSpec(repo, specPath, model)).rejects.toThrow(/PRB-1/);
    await expect(admitFromSpec(repo, specPath, model)).rejects.toThrow(/--start-over PRB-1/);
    expect(model.requests).toHaveLength(0);
    // Refused before a model was asked, and nothing written: still one ticket.
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  });

  it("lets a spec whose only ticket is spent be drafted from again", async () => {
    // A ticket at plan_invalid, cancelled or failed is not the plan this spec
    // has — it is the plan it did not get, and `--start-over` refuses all
    // three. Admitting again is the way out, so the guard must not be a dead
    // end.
    const { repo, specPath } = repository();
    expect((await admitFromSpec(repo, specPath, scripted([submits(drafted)]))).code).toBe(
      EXIT_CODES.approve,
    );
    const dir = storeDir(repo, null);
    const ticket = readTicket(dir, "PRB-1");
    writeFileSync(
      join(dir, "tickets", "PRB-1.json"),
      JSON.stringify({ ...ticket, state: "plan_invalid" }, null, 2),
    );

    expect((await admitFromSpec(repo, specPath, scripted([submits(drafted)]))).code).toBe(
      EXIT_CODES.approve,
    );
    expect(
      listTickets(dir)
        .map((each) => each.key)
        .sort(),
    ).toEqual(["PRB-1", "PRB-2"]);
  });

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

  it("calls the ticket what the drafter named the work, not the outcome sentence", async () => {
    const { repo, specPath } = repository();
    const { code } = await admitFromSpec(
      repo,
      specPath,
      scripted([submits({ ...drafted, name: "Activation email retries" })]),
    );
    expect(code).toBe(EXIT_CODES.approve);

    // The drafter read the spec and the repository before saying this, so it
    // names what the plan turned out to be — and it is short, which a board
    // needs. The outcome is still the contract's outcome; it is a sentence,
    // and a sentence is not a name.
    const ticket = readTicket(storeDir(repo, null), "PRB-1");
    expect(ticket.title).toBe("Activation email retries");
    expect(readContract(storeDir(repo, null), "PRB-1").outcome).toBe(drafted.outcome);
    expect(ticket.title).not.toBe(drafted.outcome);
  });

  it("flattens a name a model wrote across lines", async () => {
    // Shown as a title, so it is one line and it fits (ADR-0023 §4).
    const { repo, specPath } = repository();
    await admitFromSpec(
      repo,
      specPath,
      scripted([submits({ ...drafted, name: "Activation\n  email  retries" })]),
    );
    expect(readTicket(storeDir(repo, null), "PRB-1").title).toBe("Activation email retries");
  });

  it("shows the drafter every other ticket's name, whatever its state", async () => {
    // D-127: the name is told apart
    // from every row a person's board shows, and that is more than the
    // tickets in flight.
    const { repo, specPath } = repository();
    const dir = storeDir(repo, null);
    await admitTyped(repo, "Snake on a walled board");
    await admitTyped(repo, "Twin-dial clock");
    const merged = readTicket(dir, "PRB-2");
    writeFileSync(join(dir, "tickets", "PRB-2.json"), JSON.stringify({ ...merged, state: "merged" }, null, 2));

    const model = scripted([submits({ ...drafted, name: "Activation email retries" })]);
    await admitFromSpec(repo, specPath, model);
    expect(namesShown(model)).toEqual(["Snake on a walled board", "Twin-dial clock"]);
  });

  it("leaves the ticket being drafted again off the names, so its own name is not taken from it", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits({ ...drafted, name: "Activation email retries" })]));
    await admitTyped(repo, "Snake on a walled board");

    const model = scripted([submits({ ...drafted, name: "Activation email retries" })]);
    const { code } = await admitFromSpec(repo, specPath, model, ["--start-over", "PRB-1"]);
    expect(code).toBe(EXIT_CODES.approve);
    expect(namesShown(model)).toEqual(["Snake on a walled board"]);
    expect(readTicket(storeDir(repo, null), "PRB-1").title).toBe("Activation email retries");
  });

  it("passes over a drafted name another ticket carries, for the spec's title and then the outcome", async () => {
    // The same name to a person scanning the board, whatever its case and
    // spacing. The draft is kept: only the name falls back.
    const { repo, specPath } = repository();
    await admitTyped(repo, "activation  EMAIL retries");
    const { code } = await admitFromSpec(
      repo,
      specPath,
      scripted([submits({ ...drafted, name: "Activation email retries" })]),
    );
    expect(code).toBe(EXIT_CODES.approve);
    expect(readTicket(storeDir(repo, null), "PRB-2").title).toBe("Activation email");

    // With the spec's title taken too, the outcome is what is left.
    const other = repository();
    await admitTyped(other.repo, "Activation email retries");
    await admitTyped(other.repo, "Activation Email");
    await admitFromSpec(
      other.repo,
      other.specPath,
      scripted([submits({ ...drafted, name: "Activation email retries" })]),
    );
    expect(readTicket(storeDir(other.repo, null), "PRB-3").title).toBe(drafted.outcome);
  });

  it("passes over a spec still Untitled for the outcome, where the drafted name is taken (D-118)", async () => {
    const { repo, specPath } = repository(SPEC.replace("# Activation email", "# Untitled"));
    await admitTyped(repo, "Activation email retries");
    await admitFromSpec(repo, specPath, scripted([submits({ ...drafted, name: "Activation email retries" })]));
    expect(readTicket(storeDir(repo, null), "PRB-2").title).toBe(drafted.outcome);
  });

  it("keeps the drafted name when the outcome is edited", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits({ ...drafted, name: "Activation email retries" })]));
    const code = await runCommandLine(editCommandLine, {
      argv: ["PRB-1", "--repo", repo, "--outcome", "New users receive an activation email within 30 seconds."],
      streams: recordStreams(),
      cwd: repo,
      deps: { env: {} },
    });
    expect(code).toBe(EXIT_CODES.approve);
    const dir = storeDir(repo, null);
    expect(readContract(dir, "PRB-1").outcome).toBe("New users receive an activation email within 30 seconds.");
    expect(readTicket(dir, "PRB-1").title).toBe("Activation email retries");
  });

  it("shows the person the graph and the No-Gos it just recorded", async () => {
    const { repo, specPath } = repository();
    const { streams } = await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    const err = streams.err();
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
    const streams = recordStreams();
    const code = runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it",
        "--path", "docs/**",
      ],
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
    const streams = recordStreams();
    runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it",
        "--path", "docs/**",
      ],
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
    expect(() => admitCommandLine.read(["--from-spec", "a.md", "--from", "o/r#1"]).input).toThrow(UsageError);
    expect(() => admitCommandLine.read(["--from-spec", "a.md", "--from-file", "b.md"]).input).toThrow(UsageError);
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
    expect(streams.err()).toContain("graph");
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

describe("the spec takes the ticket's name", () => {
  // D-127: the Spec pane, the picker
  // and the contract's head show one name, so the spec's title line is
  // rewritten to the ticket's. The folder keeps its slug, which the record's
  // path names (ADR-0023 §4).
  const specFolders = (repo: string) => readdirSync(join(repo, "specs")).sort();
  const named = (name: string) => scripted([submits({ ...drafted, name })]);

  it("is titled with the drafted name, the folder unchanged and the record hashing it as renamed", async () => {
    const { repo, specPath } = repository();
    const { code } = await admitFromSpec(repo, specPath, named("Activation email retries"));
    expect(code).toBe(EXIT_CODES.approve);

    expect(readFileSync(specPath, "utf8")).toBe(SPEC.replace("# Activation email\n", "# Activation email retries\n"));
    expect(specFolders(repo)).toEqual(["activation-email"]);
    const dir = storeDir(repo, null);
    const spec = readTicket(dir, "PRB-1").admission.spec;
    expect(spec?.path).toBe("specs/activation-email/spec.md");
    expect(spec?.content_sha256).toBe(hashOf(specPath));
    expect(spec?.files.find((file) => file.path === "specs/activation-email/spec.md")?.content_sha256).toBe(hashOf(specPath));
    // The verdict a fresh draft is seeded with holds at the renamed spec, so
    // the way to the contract calls no model for the rename.
    expect(readDriftRecord(dir, "PRB-1")?.spec).toBe(hashOf(specPath));
  });

  it("is titled again when the ticket is drafted again under another name", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, named("Activation email retries"));
    const { code } = await admitFromSpec(repo, specPath, named("Retried activation email"), ["--start-over", "PRB-1"]);
    expect(code).toBe(EXIT_CODES.approve);
    const dir = storeDir(repo, null);
    expect(readTicket(dir, "PRB-1").title).toBe("Retried activation email");
    expect(readFileSync(specPath, "utf8").split("\n")[0]).toBe("# Retried activation email");
    expect(specFolders(repo)).toEqual(["activation-email"]);
    expect(readTicket(dir, "PRB-1").admission.spec?.content_sha256).toBe(hashOf(specPath));
    expect(readDriftRecord(dir, "PRB-1")?.spec).toBe(hashOf(specPath));
  });

  it("is left as it was where the node pages refuse the admission", async () => {
    const { repo, specPath } = repository();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    symlinkSync(elsewhere, join(repo, "specs", "activation-email", "nodes"));
    await expect(admitFromSpec(repo, specPath, named("Activation email retries"))).rejects.toThrow(/symlink/);
    expect(readFileSync(specPath, "utf8")).toBe(SPEC);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("keeps its own title where that is the name, and takes the outcome where the outcome is", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, scripted([submits(drafted)]));
    expect(readFileSync(specPath, "utf8")).toBe(SPEC);

    const other = repository();
    await admitTyped(other.repo, "Activation email retries");
    await admitTyped(other.repo, "Activation Email");
    await admitFromSpec(other.repo, other.specPath, named("Activation email retries"));
    expect(readFileSync(other.specPath, "utf8").split("\n")[0]).toBe(`# ${drafted.outcome}`);
  });
});

describe("--keep-title: the spec's title is a name a person gave the work", () => {
  // D-127: a name the person gave is kept for the spec, the ticket and the
  // plan, so the drafter's proposal is not used and the spec is left as it is.
  const named = (name: string) => scripted([submits({ ...drafted, name })]);

  it("names the ticket after the spec's title and leaves the spec's bytes as they were", async () => {
    const { repo, specPath } = repository();
    const { code } = await admitFromSpec(repo, specPath, named("Activation email retries"), ["--keep-title"]);
    expect(code).toBe(EXIT_CODES.approve);
    const dir = storeDir(repo, null);
    expect(readTicket(dir, "PRB-1").title).toBe("Activation email");
    expect(readFileSync(specPath, "utf8")).toBe(SPEC);
    expect(readTicket(dir, "PRB-1").admission.spec?.content_sha256).toBe(hashOf(specPath));
    expect(readDriftRecord(dir, "PRB-1")?.spec).toBe(hashOf(specPath));
  });

  it("keeps the person's name where another ticket already carries it", async () => {
    const { repo, specPath } = repository();
    await admitTyped(repo, "Activation email");
    await admitFromSpec(repo, specPath, named("Activation email retries"), ["--keep-title"]);
    expect(readTicket(storeDir(repo, null), "PRB-2").title).toBe("Activation email");
    expect(readFileSync(specPath, "utf8")).toBe(SPEC);
  });

  it("keeps the title the person gave the spec since, when the ticket is drafted again", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath, named("Activation email retries"));
    const retitled = readFileSync(specPath, "utf8").replace(/^# .*\n/, "# Welcome email\n");
    writeFileSync(specPath, retitled);
    const { code } = await admitFromSpec(repo, specPath, named("Retried activation email"), [
      "--start-over",
      "PRB-1",
      "--keep-title",
    ]);
    expect(code).toBe(EXIT_CODES.approve);
    const dir = storeDir(repo, null);
    expect(readTicket(dir, "PRB-1").title).toBe("Welcome email");
    expect(readFileSync(specPath, "utf8")).toBe(retitled);
    expect(readTicket(dir, "PRB-1").admission.spec?.content_sha256).toBe(hashOf(specPath));
  });

  it("refuses a title longer than a ticket's name may be, before a model is asked, and writes nothing", async () => {
    const long = "Activation email " + "x".repeat(44);
    expect(long).toHaveLength(61);
    const { repo, specPath } = repository(SPEC.replace("# Activation email\n", `# ${long}\n`));
    const before = readFileSync(specPath, "utf8");
    const model = named("Activation email retries");
    await expect(admitFromSpec(repo, specPath, model, ["--keep-title"])).rejects.toThrow(
      "the spec's title is 61 characters, and a ticket's name is at most 60 (D-127): shorten the title, then draft the plan again",
    );
    expect(model.requests).toHaveLength(0);
    expect(listTickets(storeDir(repo, null))).toEqual([]);
    expect(readFileSync(specPath, "utf8")).toBe(before);
    // Sixty is a name it keeps.
    const fits = repository(SPEC.replace("# Activation email\n", `# ${long.slice(0, 60)}\n`));
    await admitFromSpec(fits.repo, fits.specPath, named("Activation email retries"), ["--keep-title"]);
    expect(readTicket(storeDir(fits.repo, null), "PRB-1").title).toBe(long.slice(0, 60));
  });

  it("is refused without a spec to keep the title of", () => {
    expect(() =>
      admitCommandLine.read(["--from-file", "issue.md", "--keep-title"]).input,
    ).toThrow(/--keep-title names the ticket after its spec's title, so it needs the spec/);
  });
});
