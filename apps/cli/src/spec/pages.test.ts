import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import {
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";
import { UsageError } from "../usage-error.js";
import {
  admitCommandLine,
  admitDraft,
  approveCommandLine,
  defaultAdmission,
} from "../commands/admit.js";
import { editCommandLine } from "../commands/edit/index.js";
import { TICKET_RUNS } from "../commands/run/index.js";
import { listTickets, readContract, readDraftSnapshot, readTicket, storeDir } from "../store/tickets.js";
import { specFolder } from "../store/index.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { gitEnvironment } from "@perbo/test-support";

/**
 * SCP-336: the spec folder the plan is kept beside — the page per node, its
 * regeneration, and re-drafting the same ticket from the spec.
 *
 * Every drafter here is a scripted double. Nothing in this file calls a model.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-spec-folder-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A duplicate signup inside five minutes queues nothing.
- R4: A failed send is retried three times.
- R5: The queue reports how many messages are waiting.

## No-Gos

- Nothing is sent to an address that has unsubscribed.
- No change to the signup form.

## Rabbit holes

- Templating: the existing template stays.

## Notes

The queue package already has a sender.
`;

let repos = 0;
function repository(spec = SPEC): { repo: string; specPath: string; folder: string } {
  const repo = join(scratch, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const folder = join(repo, "specs", "activation-email");
  mkdirSync(folder, { recursive: true });
  const specPath = join(folder, "spec.md");
  writeFileSync(specPath, spec);
  for (const name of ["queue", "auth"]) {
    mkdirSync(join(repo, "packages", name), { recursive: true });
    writeFileSync(join(repo, "packages", name, "index.ts"), "export const a = 1;\n");
  }
  execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnvironment() });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitEnvironment() });
  return { repo, specPath, folder };
}

function scripted(script: Array<Array<{ tool: string; input: unknown }>>): Model {
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    async turn(_request: ModelRequest): Promise<ModelTurn> {
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

/** The same double, counting what was asked of it. */
function scriptedWithCount(script: Array<Array<{ tool: string; input: unknown }>>) {
  let turns = 0;
  const inner = scripted(script);
  return {
    turns: () => turns,
    model: {
      ...inner,
      turn: (request: ModelRequest) => {
        turns += 1;
        return inner.turn(request);
      },
    } as Model,
  };
}

const drafted = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    { text: "A signup POST queues one activation email.", assertion: "one message is queued", kind: "test", requirement_id: "R1" },
    { text: "A duplicate signup queues nothing.", assertion: "a second signup queues nothing", kind: "test", requirement_id: "R2" },
    { text: "A failed send is retried three times.", assertion: "three attempts are recorded", kind: "test", requirement_id: "R4" },
  ],
  proposed_scope: { paths_allowed: ["packages/queue/**", "packages/auth/**"], paths_prohibited_extra: [] },
  rationale: "The spec's requirements fall into queueing and retrying.",
  depends_on: [],
  nodes: [
    { title: "Queue the email", criteria: [0, 1], paths: ["packages/queue/**"] },
    { title: "Retry a failed send", criteria: [2], paths: ["packages/queue/**"] },
  ],
  edges: [{ from: 0, to: 1 }],
};

const redraftFrom = (repo: string, specPath: string, key: string) =>
  runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, "--start-over", key], streams: recordStreams(), cwd: repo, deps: { model: scripted([submits(drafted)]) } });

const admitFromSpec = async (repo: string, specPath: string, extra: string[] = [], draft = drafted) => {
  const streams = recordStreams();
  const code = await runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, ...extra], streams, cwd: repo, deps: { model: scripted([submits(draft)]) } });
  return { code, streams };
};

const pagesIn = (folder: string): string[] => {
  try {
    return readdirSync(join(folder, "nodes")).sort();
  } catch {
    return [];
  }
};
const page = (folder: string, node: string): string =>
  readFileSync(join(folder, "nodes", `${node}.md`), "utf8");

const graphEdit = (repo: string, edit: unknown) =>
  runCommandLine(editCommandLine, {
    argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edit)],
    streams: recordStreams(),
    cwd: repo,
  });

describe("the page per node beside the spec", () => {
  it("is written for each node of the drafted plan, from the spec and the graph", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    expect(pagesIn(folder)).toEqual(["node_1.md", "node_2.md"]);

    const first = page(folder, "node_1");
    expect(first).toContain("# Queue the email");
    expect(first).toContain("R1: A signup POST queues exactly one activation email.");
    expect(first).toContain("R2: A duplicate signup inside five minutes queues nothing.");
    expect(first).not.toContain("R4:");
    expect(first).toContain("ac_1");
    expect(first).toContain("one message is queued");
    expect(first).toContain("packages/queue/**");
    expect(first).toContain("Nothing is sent to an address that has unsubscribed.");
    // R5 is cited by no criterion, so it is on no page at all.
    expect(first + page(folder, "node_2")).not.toContain("R5:");
  });

  it("is regenerated after a graph edit, and the deleted node's page goes with it", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    expect(await graphEdit(repo, { op: "delete_node", id: "node_2", move_criteria_to: "node_1" })).toBe(
      EXIT_CODES.approve,
    );
    expect(pagesIn(folder)).toEqual(["node_1.md"]);
    expect(page(folder, "node_1")).toContain("R4: A failed send is retried three times.");
  });

  it("is regenerated after an undo, back to what the graph was before it", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    await graphEdit(repo, { op: "delete_node", id: "node_2", move_criteria_to: "node_1" });
    expect(pagesIn(folder)).toEqual(["node_1.md"]);
    expect(
      await runCommandLine(editCommandLine, { argv: ["PRB-1", "--repo", repo, "--undo", "1"], streams: recordStreams(), cwd: repo }),
    ).toBe(EXIT_CODES.approve);
    expect(pagesIn(folder)).toEqual(["node_1.md", "node_2.md"]);
    expect(page(folder, "node_1")).not.toContain("R4:");
  });

  it("is regenerated after a flag edit, and a plan left flat keeps none", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath, [], { ...drafted, nodes: [], edges: [] });
    expect(pagesIn(folder)).toEqual([]);
    // A graph built by hand gets pages; narrowing the scope by flag keeps them current.
    await graphEdit(repo, {
      op: "add_node",
      title: "Queue the email",
      criteria: ["ac_1", "ac_2", "ac_3"],
      paths: ["packages/queue/**"],
    });
    expect(pagesIn(folder)).toEqual(["node_1.md"]);
    expect(
      await runCommandLine(editCommandLine, {
        argv: ["PRB-1", "--repo", repo, "--path", "packages/queue/**"],
        streams: recordStreams(),
        cwd: repo,
      }),
    ).toBe(EXIT_CODES.approve);
    expect(page(folder, "node_1")).toContain("packages/queue/**");
  });

  it("is refused, and the edit with it, where the spec can no longer be read", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const before = readContract(dir, "PRB-1");
    const count = readTicket(dir, "PRB-1").admission.edit_count;
    rmSync(specPath);
    await expect(
      graphEdit(repo, { op: "delete_node", id: "node_2", move_criteria_to: "node_1" }),
    ).rejects.toThrow(/cannot be read now/);
    expect(readContract(dir, "PRB-1")).toEqual(before);
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(count);
  });

  it("is never written through a symlink: admission refuses the spec, and an edit refuses whole", async () => {
    const { repo, specPath, folder } = repository();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    // The spec folder replaced by a link out of the repository before admission.
    writeFileSync(join(elsewhere, "spec.md"), SPEC);
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(elsewhere, folder);
    await expect(
      runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath], streams: recordStreams(), cwd: repo, deps: { model: scripted([]) } }),
    ).rejects.toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "nodes"))).toBe(false);
    expect(listTickets(storeDir(repo, null))).toEqual([]);

    // Admitted through a real folder, then the folder replaced by a link: the
    // next edit is refused before it writes anything.
    rmSync(folder, { force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(specPath, SPEC);
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const before = readContract(dir, "PRB-1");
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(elsewhere, folder);
    await expect(
      graphEdit(repo, { op: "delete_node", id: "node_2", move_criteria_to: "node_1" }),
    ).rejects.toThrow(/symlink/);
    expect(readContract(dir, "PRB-1")).toEqual(before);
    expect(existsSync(join(elsewhere, "nodes"))).toBe(false);
  });

  it("refuses a page that is a link before an edit writes anything", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const before = readContract(dir, "PRB-1");
    const count = readTicket(dir, "PRB-1").admission.edit_count;
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    writeFileSync(join(elsewhere, "target.md"), "# elsewhere\n");
    rmSync(join(folder, "nodes", "node_1.md"));
    symlinkSync(join(elsewhere, "target.md"), join(folder, "nodes", "node_1.md"));
    await expect(
      runCommandLine(editCommandLine, {
        argv: ["PRB-1", "--repo", repo, "--outcome", "Changed behind a linked page."],
        streams: recordStreams(),
        cwd: repo,
      }),
    ).rejects.toThrow(/symlink/);
    expect(readContract(dir, "PRB-1")).toEqual(before);
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(count);
    expect(readFileSync(join(elsewhere, "target.md"), "utf8")).toBe("# elsewhere\n");
  });

  it("is checked before admission writes a record, and before a re-draft moves the plan", async () => {
    const { repo, specPath, folder } = repository();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    // A nodes folder that is a link out of the repository, before anything is admitted.
    symlinkSync(elsewhere, join(folder, "nodes"));
    await expect(admitFromSpec(repo, specPath)).rejects.toThrow(/symlink/);
    expect(listTickets(storeDir(repo, null))).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);

    // Admitted through a real folder, then a page replaced by a link: starting
    // over is refused with the plan where it was. The refused admission took a
    // key with it, as any key once issued is never issued again.
    rmSync(join(folder, "nodes"));
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const key = listTickets(dir)[0]!.key;
    expect(key).toBe("PRB-2");
    writeFileSync(join(elsewhere, "target.md"), "# elsewhere\n");
    rmSync(join(folder, "nodes", "node_1.md"));
    symlinkSync(join(elsewhere, "target.md"), join(folder, "nodes", "node_1.md"));
    await expect(redraftFrom(repo, specPath, key)).rejects.toThrow(/symlink/);
    expect(readTicket(dir, key).plan_version).toBe(1);
    expect(readContract(dir, key).version).toBe(1);
    expect(readFileSync(join(elsewhere, "target.md"), "utf8")).toBe("# elsewhere\n");
  });

  it("keeps a hand-written Notes section across every regeneration", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    const path = join(folder, "nodes", "node_1.md");
    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\nAsk Ana before the template changes.\n`);
    await graphEdit(repo, { op: "set_node_paths", id: "node_1", paths: ["packages/auth/**"] });
    expect(readFileSync(path, "utf8")).toContain("Ask Ana before the template changes.");
    expect(readFileSync(path, "utf8")).toContain("packages/auth/**");
  });

  it("leaves a supporting file beside the spec alone and never reads one as input", async () => {
    const { repo, specPath, folder } = repository();
    writeFileSync(join(folder, "measurements.md"), "# Measurements\n\n- R9: not a requirement\n");
    await admitFromSpec(repo, specPath);
    mkdirSync(join(folder, "nodes"), { recursive: true });
    writeFileSync(join(folder, "nodes", "reading.txt"), "kept");
    await graphEdit(repo, { op: "set_node_paths", id: "node_1", paths: ["packages/auth/**"] });
    expect(readFileSync(join(folder, "measurements.md"), "utf8")).toContain("R9: not a requirement");
    expect(readFileSync(join(folder, "nodes", "reading.txt"), "utf8")).toBe("kept");
    // Nothing beside the spec reached the contract: R9 is not a requirement of it.
    const contract = readContract(storeDir(repo, null), "PRB-1");
    const cited = "acceptance_criteria" in contract
      ? contract.acceptance_criteria.map((criterion) => criterion.requirement_id)
      : [];
    expect(cited).toEqual(["R1", "R2", "R4"]);
  });
});

describe("the No-Gos a run's brief carries (D-096, D-100)", () => {
  const configFor = (repo: string): { no_gos: string[] } => {
    const dir = storeDir(repo, null);
    const work = { dir, key: "PRB-1", contract: readContract(dir, "PRB-1") };
    return TICKET_RUNS.runConfig(work, undefined, false) as { no_gos: string[] };
  };

  it("come from the ticket's own approach record", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    expect(configFor(repo).no_gos).toEqual([
      "Nothing is sent to an address that has unsubscribed.",
      "No change to the signup form.",
    ]);
  });

  it("are left empty, with a warning, where the record belongs to another plan", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    const path = join(storeDir(repo, null), "tickets", "PRB-1.approach.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { plan_id: string };
    writeFileSync(path, JSON.stringify({ ...record, plan_id: "plan_0000000000000000" }));
    const warned: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warned.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(configFor(repo).no_gos).toEqual([]);
    } finally {
      process.stderr.write = write;
    }
    expect(warned.join("")).toContain("carries no No-Gos");
    expect(warned.join("")).toContain("it is another plan's approach");
  });
});

describe("perbo admit --from-spec --start-over", () => {
  const redraft = async (repo: string, specPath: string, extra: string[] = [], draft = drafted) => {
    const streams = recordStreams();
    const code = await runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, "--start-over", "PRB-1", ...extra], streams, cwd: repo, deps: { model: scripted([submits(draft)]) } });
    return { code, streams };
  };

  it("re-drafts the same ticket, admits no other, and moves the plan to a new version", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const before = readTicket(dir, "PRB-1");

    expect((await redraft(repo, specPath)).code).toBe(EXIT_CODES.approve);
    expect(listTickets(dir).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
    const after = readTicket(dir, "PRB-1");
    expect(after.ticket_id).toBe(before.ticket_id);
    expect(after.state).toBe("plan_review");
    expect(after.plan_version).toBe(2);
    const contract = readContract(dir, "PRB-1");
    expect(contract.version).toBe(2);
    expect(contract.plan_id).toBe(before.plan_id);
    expect(contract.ticket_id).toBe(before.ticket_id);
    // The spec's own hash is recorded again: the file may have changed since.
    expect(after.admission.spec?.path).toBe("specs/activation-email/spec.md");
    expect(after.admission.criteria_source).toBe("spec");
  });

  it("drops the graph edits and the paths they added, and keeps the spec's No-Gos", async () => {
    const { repo, specPath, folder } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    // A graph edited by hand: a node renamed, and a path added to another.
    await graphEdit(repo, {
      op: "set_node_paths",
      id: "node_1",
      paths: ["packages/queue/**", "packages/auth/**"],
    });
    await graphEdit(repo, { op: "remove_edge", from: "node_1", to: "node_2" });
    const edited = readContract(dir, "PRB-1");
    expect((edited as { nodes?: Array<{ paths: string[] }> }).nodes?.[0]?.paths).toEqual([
      "packages/queue/**",
      "packages/auth/**",
    ]);

    // The spec is edited between the two drafts: a No-Go is added, and it is in
    // the file, so the re-draft reads it rather than losing it.
    writeFileSync(
      specPath,
      readFileSync(specPath, "utf8").replace(
        "- No change to the signup form.",
        "- No change to the signup form.\n- No second provider.",
      ),
    );
    await redraft(repo, specPath);
    const contract = readContract(dir, "PRB-1");
    const nodes = (contract as { nodes?: Array<{ id: string; title: string; paths: string[] }> }).nodes;
    expect(nodes?.[0]?.paths).toEqual(["packages/queue/**"]);
    expect(nodes?.map((node) => node.title)).toEqual(["Queue the email", "Retry a failed send"]);

    // The spec's No-Gos are in the file, so they survive whole.
    const approach = JSON.parse(readFileSync(join(dir, "tickets", "PRB-1.approach.json"), "utf8")) as {
      edges: unknown[];
      no_gos: string[];
    };
    expect(approach.no_gos).toEqual([
      "Nothing is sent to an address that has unsubscribed.",
      "No change to the signup form.",
      "No second provider.",
    ]);
    expect(approach.edges).toEqual([{ from: "node_1", to: "node_2" }]);
    // The spec's requirement ids are the file's, so the re-draft keeps them
    // and the criteria cite the same ones.
    expect(readFileSync(specPath, "utf8")).toContain("- R4: A failed send is retried three times.");
    expect(
      "acceptance_criteria" in contract
        ? contract.acceptance_criteria.map((criterion) => criterion.requirement_id)
        : [],
    ).toEqual(["R1", "R2", "R4"]);
    // And the node pages follow the new graph.
    expect(page(folder, "node_1")).toContain("packages/queue/**");
    expect(page(folder, "node_1")).not.toContain("packages/auth/**");
  });

  it("records the re-draft in the edit log, so the count starts again and no older undo reaches back", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    await graphEdit(repo, { op: "set_node_paths", id: "node_1", paths: ["packages/auth/**"] });
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBeGreaterThan(0);

    await redraft(repo, specPath);
    const snapshot = readDraftSnapshot(dir, "PRB-1")!;
    expect(snapshot.edits[0]?.replaced).toBe(true);
    expect(snapshot.edits.at(-1)?.summary).toMatch(/re-drafted from the spec/);
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(0);

    await expect(
      runCommandLine(editCommandLine, { argv: ["PRB-1", "--repo", repo, "--undo", "1"], streams: recordStreams(), cwd: repo }),
    ).rejects.toThrow(/re-drafted/);
  });

  it("refuses a ticket that is not in plan_review, and one that does not exist", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    // Approved, and the contract is immutable from then on (ADR-0016).
    expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo })).toBe(
      EXIT_CODES.approve,
    );
    // Refused before a model is asked anything, as a spec outside the
    // repository is: the draft would have been paid for either way.
    const untouched = scriptedWithCount([submits(drafted)]);
    expect(() =>
      runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, "--start-over", "PRB-1"], streams: recordStreams(), cwd: repo, deps: { model: untouched.model } }),
    ).toThrow(/immutable/);
    expect(untouched.turns()).toBe(0);

    expect(() =>
      runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, "--start-over", "PRB-9"], streams: recordStreams(), cwd: repo, deps: { model: scripted([submits(drafted)]) } }),
    ).toThrow(/PRB-9/);
  });

  it("refuses a spec other than the one the ticket was drafted from, and a ticket drafted from none", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    const dir = storeDir(repo, null);
    const other = join(repo, "specs", "something-else");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "spec.md"), SPEC.replace("# Activation email", "# Something else"));
    const before = readTicket(dir, "PRB-1");
    await expect(redraft(repo, join(other, "spec.md"))).rejects.toThrow(
      /drafted from specs\/activation-email\/spec\.md/,
    );
    expect(readTicket(dir, "PRB-1").admission.spec?.path).toBe(before.admission.spec?.path);
    expect(readTicket(dir, "PRB-1").plan_version).toBe(before.plan_version);
    expect(readdirSync(other)).toEqual(["spec.md"]);

    runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it", "--path", "docs/**",
      ],
      streams: recordStreams(),
      cwd: repo,
    });
    // Refused before the model is asked, so the refusal is immediate.
    expect(() =>
      runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath, "--start-over", "PRB-2"], streams: recordStreams(), cwd: repo, deps: { model: scripted([submits(drafted)]) } }),
    ).toThrow(/PRB-2 was not drafted from a spec/);
    expect(readTicket(dir, "PRB-2").admission.spec).toBeNull();
    expect(readTicket(dir, "PRB-2").plan_version).toBe(1);
  });

  it("needs a spec to start over from, and cannot approve in the same command", () => {
    expect(() => admitCommandLine.read(["--start-over", "PRB-1"]).input).toThrow(UsageError);
    // And the same for a caller that built the flags rather than parsing them.
    expect(() =>
      admitDraft(
        { ...defaultAdmission({ repo: ".", store: null }), fromFile: "issue.md", startOver: "PRB-1" },
        {
          cwd: scratch,
          now: new Date(),
          diagnostics: recordStreams(),
          model: scripted([submits(drafted)]),
        },
      ),
    ).toThrow(/--from-spec/);
    expect(() => admitCommandLine.read(["--from-spec", "a.md", "--start-over", "prb-1"]).input).toThrow(UsageError);
    expect(() =>
      admitCommandLine.read(["--from-spec", "a.md", "--start-over", "PRB-1", "--approve"]).input,
    ).toThrow(UsageError);
  });
});

describe("the spec folder a repository configures", () => {
  it("is read from .perbo/config.json and is where a spec's pages are written", async () => {
    const repo = join(scratch, `repo-config-${repos++}`);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ specs: "docs/specs" }));
    const folder = join(repo, "docs", "specs", "activation-email");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "spec.md"), SPEC);
    mkdirSync(join(repo, "packages", "queue"), { recursive: true });
    writeFileSync(join(repo, "packages", "queue", "index.ts"), "export const a = 1;\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnvironment() });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitEnvironment() });

    await admitFromSpec(repo, join(folder, "spec.md"));
    expect(pagesIn(folder)).toEqual(["node_1.md", "node_2.md"]);
    // The configured folder is off limits to the executor, beside the default.
    const contract = readContract(storeDir(repo, null), "PRB-1");
    expect(contract.scope.paths_prohibited).toContain("docs/specs/**");
    expect(contract.scope.paths_prohibited).toContain("specs/**");
  });

  it("refuses a folder spelled with a backslash, which the prohibition glob could not match", () => {
    const { repo } = repository();
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ specs: "docs\\specs" }));
    expect(() => specFolder(storeDir(repo, null))).toThrow(/repository-relative folder/);
  });

  it("puts specs/** off limits in every contract, configured or not", async () => {
    const { repo, specPath } = repository();
    await admitFromSpec(repo, specPath);
    expect(readContract(storeDir(repo, null), "PRB-1").scope.paths_prohibited).toContain("specs/**");
    const streams = recordStreams();
    runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo, "--outcome", "Docs say what is true.",
        "--criterion", "the page exists :: a test reads it", "--path", "docs/**",
      ],
      streams,
      cwd: repo,
    });
    expect(readContract(storeDir(repo, null), "PRB-2").scope.paths_prohibited).toContain("specs/**");
  });
});
