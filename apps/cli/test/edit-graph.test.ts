import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, hasAcceptanceCriteria, planNodes } from "@perbo/contracts";
import { UsageError } from "../src/usage-error.js";
import { parseAdmitArgs, runAdmitCommand, runApproveCommand } from "../src/admit.js";
import type { Streams } from "../src/streams.js";
import { runEditCommand } from "../src/edit.js";
import { exitForThrown } from "../src/entry.js";
import {
  approachPathFor,
  contractPathFor,
  readApproachRecord,
  readContract,
  readDraftSnapshot,
  readTicket,
  storeDir,
} from "../src/tickets.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-edit-graph-test-"));
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

let repos = 0;
/** A ticket with four criteria over two packages, and no graph yet. */
function admitted(): { repo: string; dir: string } {
  const repo = join(scratch, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: gitIdentity,
  });
  const code = runAdmitCommand({
    args: parseAdmitArgs([
      "--repo", repo,
      "--outcome", "New users receive an activation email.",
      "--criterion", "one email is queued :: a single signup queues one message",
      "--criterion", "a duplicate queues nothing :: a second signup queues nothing",
      "--criterion", "a failed send is retried :: three attempts are recorded",
      "--criterion", "the report counts activations :: the daily report shows the count",
      "--path", "packages/queue/**",
      "--path", "packages/reports/**",
    ]),
    streams: capture(),
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error("admission failed");
  return { repo, dir: storeDir(repo, null) };
}

const edit = (repo: string, argv: string[]) =>
  runEditCommand({ argv: ["PRB-1", "--repo", repo, ...argv], streams: capture(), cwd: repo });

const graphEdit = (repo: string, edits: unknown, extra: string[] = []) =>
  runEditCommand({
    argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edits), ...extra],
    streams: capture(),
    cwd: repo,
  });

/**
 * The two nodes most of these start from, built the way a person builds one:
 * a node of the whole plan, then a split. Two recorded edits, so an `--undo`
 * below numbers from three.
 */
async function withTwoNodes(): Promise<{ repo: string; dir: string }> {
  const { repo, dir } = admitted();
  await graphEdit(repo, {
    op: "add_node",
    title: "The whole of it",
    paths: ["packages/queue/**", "packages/reports/**"],
    criteria: ["ac_1", "ac_2", "ac_3", "ac_4"],
  });
  await graphEdit(repo, {
    op: "split_node",
    id: "node_1",
    into: [
      { title: "Queue the email", criteria: ["ac_1", "ac_2", "ac_3"], paths: ["packages/queue/**"] },
      { title: "Count them", criteria: ["ac_4"], paths: ["packages/reports/**"] },
    ],
  });
  return { repo, dir };
}

describe("perbo edit --graph-edit", () => {
  it("refuses to start from a contract file that differs from its counter-seal", async () => {
    // The graph path starts from the contract file, as approve and run do, and
    // like them it takes only the file the counter-seal vouches for: a hand
    // edit left there, refused or not, is neither built on nor re-sealed.
    const { repo, dir } = admitted();
    const path = contractPathFor(dir, "PRB-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      acceptance_criteria: Array<Record<string, unknown>>;
    };
    onDisk.acceptance_criteria[0]!["requirement_id"] = "R9";
    writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`);
    await expect(
      graphEdit(repo, {
        op: "set_criterion",
        id: "ac_2",
        text: "a duplicate queues nothing at all",
        expected_verification: { kind: "test", assertion: "a second signup queues nothing" },
      }),
    ).rejects.toThrow(/draft\.json/);
    const sealed = readDraftSnapshot(dir, "PRB-1")!.contract;
    expect(
      hasAcceptanceCriteria(sealed) && sealed.acceptance_criteria.some((c) => c.requirement_id !== undefined),
    ).toBe(false);
  });

  it("refuses an edge edit on an approved contract somebody changed on disk", async () => {
    // An edge is approach and still applies after approval, but not over a
    // contract file that no longer says what was approved: the edit would
    // re-seal the altered contract and run would then bind an attempt to it.
    const { repo, dir } = await withTwoNodes();
    expect(
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo }),
    ).toBe(EXIT_CODES.approve);
    const path = contractPathFor(dir, "PRB-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { outcome: string; scope: { paths_allowed: string[] } };
    onDisk.outcome = "Something else entirely.";
    onDisk.scope.paths_allowed = ["**"];
    writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`);
    await expect(graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" })).rejects.toThrow(
      /draft\.json/,
    );
    expect(readDraftSnapshot(dir, "PRB-1")!.contract.outcome).toBe("New users receive an activation email.");
  });

  it("refuses --criterion on a plan with a graph, naming set_criterion, and changes nothing", async () => {
    const { repo, dir } = await withTwoNodes();
    const before = readContract(dir, "PRB-1");
    await expect(
      runEditCommand({
        argv: ["PRB-1", "--repo", repo, "--criterion", "one thing is true :: it is checked"],
        streams: capture(),
        cwd: repo,
      }),
    ).rejects.toThrow(/set_criterion/);
    expect(readContract(dir, "PRB-1")).toEqual(before);
  });

  it("keeps the graph under a wider --path, and refuses one that leaves a node outside", async () => {
    const { repo, dir } = await withTwoNodes();
    expect(
      await edit(repo, ["--path", "packages/queue/**", "--path", "packages/reports/**", "--path", "packages/api/**"]),
    ).toBe(EXIT_CODES.approve);
    expect(planNodes(readContract(dir, "PRB-1")).map((node) => node.id)).toEqual(["node_1", "node_2"]);
    const before = readContract(dir, "PRB-1");
    const refused: unknown = await edit(repo, ["--path", "packages/queue/**"]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("packages/reports/**");
    expect((refused as UsageError).message).toContain("set_node_paths");
    expect(readContract(dir, "PRB-1")).toEqual(before);
  });

  it("refuses an approach record that names another ticket or plan, and changes nothing", async () => {
    const { repo, dir } = await withTwoNodes();
    const path = join(dir, "tickets", "PRB-1.approach.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { plan_id: string };
    writeFileSync(path, JSON.stringify({ ...record, plan_id: "plan_00000000000000000000000000" }, null, 2));
    const before = readContract(dir, "PRB-1");
    const refused: unknown = await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" }).catch(
      (error: unknown) => error,
    );
    expect(String((refused as Error).message)).toMatch(/approach\.json names ticket/);
    expect(readContract(dir, "PRB-1")).toEqual(before);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ plan_id: "plan_00000000000000000000000000" });
  });

  it("refuses a flag edit over an approach record that names another plan, before writing anything", async () => {
    const { repo, dir } = await withTwoNodes();
    const path = join(dir, "tickets", "PRB-1.approach.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { plan_id: string };
    writeFileSync(path, JSON.stringify({ ...record, plan_id: "plan_00000000000000000000000000" }, null, 2));
    const contract = readFileSync(join(dir, "tickets", "PRB-1.contract.json"), "utf8");
    const draft = readFileSync(join(dir, "tickets", "PRB-1.draft.json"), "utf8");
    const refused: unknown = await edit(repo, ["--outcome", "Another outcome, typed"]).catch((error: unknown) => error);
    expect(String((refused as Error).message)).toMatch(/approach\.json names ticket/);
    // Neither half of the pair moved: the refusal came before the write.
    expect(readFileSync(join(dir, "tickets", "PRB-1.contract.json"), "utf8")).toBe(contract);
    expect(readFileSync(join(dir, "tickets", "PRB-1.draft.json"), "utf8")).toBe(draft);
  });

  it("adds a node from criteria already in the plan", async () => {
    const { repo, dir } = admitted();
    expect(
      await graphEdit(repo, {
        op: "add_node",
        title: "Queue the email",
        paths: ["packages/queue/**"],
        criteria: ["ac_1", "ac_2", "ac_3"],
      }),
    ).toBe(EXIT_CODES.approve);
    // The first node cannot stand alone: every criterion is in exactly one
    // node, so the rest land in a node of their own.
    const nodes = planNodes(readContract(dir, "PRB-1"));
    expect(nodes.map((node) => node.criteria)).toEqual([["ac_1", "ac_2", "ac_3"], ["ac_4"]]);
    expect(nodes[0]?.title).toBe("Queue the email");
    expect(nodes[0]?.paths).toEqual(["packages/queue/**"]);
    // The node standing in for the rest takes the plan's outcome and the whole
    // scope: what is left may land anywhere the plan already allows.
    expect(nodes[1]?.title).toBe("New users receive an activation email.");
    expect(nodes[1]?.paths).toEqual(["packages/queue/**", "packages/reports/**"]);
  });

  it("adds a node with criteria it writes itself", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, {
      op: "add_node",
      title: "Unsubscribe",
      paths: ["packages/queue/**"],
      new_criteria: [
        {
          text: "an unsubscribed address is never sent to",
          expected_verification: { kind: "test", assertion: "no message is queued for one" },
        },
      ],
    });
    const contract = readContract(dir, "PRB-1");
    expect(contract.level === "P0" ? [] : contract.acceptance_criteria.map((c) => c.id)).toEqual([
      "ac_1",
      "ac_2",
      "ac_3",
      "ac_4",
      "ac_5",
    ]);
    expect(planNodes(contract).at(-1)?.criteria).toEqual(["ac_5"]);
  });

  it("splits a node into two halves and merges two back into one", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, {
      op: "split_node",
      id: "node_1",
      into: [
        { title: "Queue it", criteria: ["ac_1", "ac_2"], paths: ["packages/queue/**"] },
        { title: "Retry it", criteria: ["ac_3"], paths: ["packages/queue/**"] },
      ],
    });
    let nodes = planNodes(readContract(dir, "PRB-1"));
    // The first half keeps the node's id and its place; the second is new and
    // sits straight after it.
    expect(nodes.map((node) => node.title)).toEqual(["Queue it", "Retry it", "Count them"]);
    expect(nodes[0]?.id).toBe("node_1");

    // An edge to a third node survives the merge; the edge between the merged
    // pair does not, because there is nothing left for it to order.
    await graphEdit(repo, { op: "add_edge", from: nodes[0]!.id, to: nodes[1]!.id });
    await graphEdit(repo, { op: "add_edge", from: nodes[1]!.id, to: "node_2" });
    await graphEdit(repo, { op: "merge_nodes", ids: [nodes[0]!.id, nodes[1]!.id] });
    nodes = planNodes(readContract(dir, "PRB-1"));
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.criteria).toEqual(["ac_1", "ac_2", "ac_3"]);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([
      { from: nodes[0]!.id, to: "node_2" },
    ]);
  });

  it("deletes a node only when its criteria are moved or deleted in the same edit", async () => {
    const { repo, dir } = await withTwoNodes();
    const stranded: unknown = await graphEdit(repo, { op: "delete_node", id: "node_2" }).catch(
      (error: unknown) => error,
    );
    expect(stranded).toBeInstanceOf(UsageError);
    expect((stranded as UsageError).message).toContain("ac_4");
    expect(planNodes(readContract(dir, "PRB-1"))).toHaveLength(2);

    await graphEdit(repo, { op: "delete_node", id: "node_2", move_criteria_to: "node_1" });
    const nodes = planNodes(readContract(dir, "PRB-1"));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.criteria).toEqual(["ac_1", "ac_2", "ac_3", "ac_4"]);
  });

  it("makes the plan flat again when the last node is deleted whole, and --criterion works once more", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    await graphEdit(repo, { op: "merge_nodes", ids: ["node_1", "node_2"], title: "All of it" });
    const [only] = planNodes(readContract(dir, "PRB-1"));
    expect(await graphEdit(repo, { op: "delete_node", id: only!.id, delete_criteria: [], move_criteria_to: null })).toBe(
      EXIT_CODES.approve,
    );
    const flat = readContract(dir, "PRB-1");
    expect(planNodes(flat)).toEqual([]);
    expect("acceptance_criteria" in flat ? flat.acceptance_criteria : []).toHaveLength(4);
    // Nothing is left for the approach record to carry, so it goes with the graph.
    expect(readApproachRecord(dir, "PRB-1")).toBeNull();
    expect(existsSync(join(dir, "tickets", "PRB-1.approach.json"))).toBe(false);
    expect(
      await runEditCommand({
        argv: ["PRB-1", "--repo", repo, "--criterion", "one thing is true :: it is checked"],
        streams: capture(),
        cwd: repo,
      }),
    ).toBe(EXIT_CODES.approve);
  });

  it("drops the order with the nodes when a hand edit ungroups a plan whose draft is gone", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    rmSync(join(dir, "tickets", "PRB-1.draft.json"));
    const script = join(scratch, "ungroup.js");
    writeFileSync(
      script,
      `const fs = require("node:fs");\nconst file = process.argv[process.argv.length - 1];\n` +
        `const c = JSON.parse(fs.readFileSync(file, "utf8"));\ndelete c.nodes;\n` +
        `fs.writeFileSync(file, JSON.stringify(c, null, 2));\n`,
    );
    expect(
      await runEditCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, env: { EDITOR: `node ${script}` } }),
    ).toBe(EXIT_CODES.approve);
    expect(planNodes(readContract(dir, "PRB-1"))).toEqual([]);
    // No nodes and no No-Gos: nothing is left for the record to carry.
    expect(readApproachRecord(dir, "PRB-1")).toBeNull();
    // A graph built again starts with no order, and the edit that built it can be undone.
    expect(
      await graphEdit(repo, {
        op: "add_node",
        title: "Again",
        paths: ["packages/queue/**", "packages/reports/**"],
        criteria: ["ac_1", "ac_2", "ac_3", "ac_4"],
      }),
    ).toBe(EXIT_CODES.approve);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);
    const count = readDraftSnapshot(dir, "PRB-1")?.edits.length ?? 0;
    expect(await edit(repo, ["--undo", String(count)])).toBe(EXIT_CODES.approve);
    expect(planNodes(readContract(dir, "PRB-1"))).toEqual([]);
  });

  it("deletes a node's criteria with it when the edit says so", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "delete_node", id: "node_2", delete_criteria: ["ac_4"] });
    const contract = readContract(dir, "PRB-1");
    expect(contract.level === "P0" ? [] : contract.acceptance_criteria.map((c) => c.id)).toEqual([
      "ac_1",
      "ac_2",
      "ac_3",
    ]);
  });

  it("states a criterion and a node's paths", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, {
      op: "set_criterion",
      id: "ac_4",
      text: "the weekly report counts activations",
      expected_verification: { kind: "test", assertion: "the weekly report shows the count" },
    });
    await graphEdit(repo, { op: "set_node_paths", id: "node_2", paths: ["packages/reports/**"] });
    const contract = readContract(dir, "PRB-1");
    const criterion = contract.level === "P0" ? undefined : contract.acceptance_criteria[3];
    expect(criterion?.text).toBe("the weekly report counts activations");
    expect(planNodes(contract)[1]?.paths).toEqual(["packages/reports/**"]);
  });

  it("refuses a node path outside the allowed scope, and changes nothing", async () => {
    const { repo, dir } = await withTwoNodes();
    const before = readFileSync(contractPathFor(dir, "PRB-1"), "utf8");
    const refused: unknown = await graphEdit(repo, {
      op: "set_node_paths",
      id: "node_2",
      paths: ["packages/billing/**"],
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("packages/billing/**");
    expect(readFileSync(contractPathFor(dir, "PRB-1"), "utf8")).toBe(before);
    expect(exitForThrown("edit", refused).code).toBe(EXIT_CODES.usage_or_input_error);
  });

  it("refuses an edge that would make a cycle, and changes nothing", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    const before = readFileSync(approachPathFor(dir, "PRB-1"), "utf8");
    const refused: unknown = await graphEdit(repo, {
      op: "add_edge",
      from: "node_2",
      to: "node_1",
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toMatch(/cycle/);
    expect(readFileSync(approachPathFor(dir, "PRB-1"), "utf8")).toBe(before);
  });

  it("removes an edge", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    await graphEdit(repo, { op: "remove_edge", from: "node_1", to: "node_2" });
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);
  });

  it("refuses an edit that is not one, naming why, before anything is written", async () => {
    const { repo, dir } = await withTwoNodes();
    const before = readFileSync(contractPathFor(dir, "PRB-1"), "utf8");
    for (const bad of ['{"op":"rename_plan"}', "not json", '{"op":"add_edge","from":"node_1"}']) {
      const refused: unknown = await runEditCommand({
        argv: ["PRB-1", "--repo", repo, "--graph-edit", bad],
        streams: capture(),
        cwd: repo,
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(UsageError);
    }
    expect(readFileSync(contractPathFor(dir, "PRB-1"), "utf8")).toBe(before);
  });

  it("records each edit with its author, summary, keys and values", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    const edits = readDraftSnapshot(dir, "PRB-1")?.edits ?? [];
    expect(edits).toHaveLength(3);
    const last = edits[2]!;
    expect(last.author).toBe("you");
    expect(last.summary).toContain("node_1 -> node_2");
    expect(last.keys).toEqual(["edge:node_1->node_2"]);
    expect(last.before).toEqual({ "edge:node_1->node_2": null });
    expect(last.after).toEqual({ "edge:node_1->node_2": { from: "node_1", to: "node_2" } });
    expect(last.undone).toBe(false);
  });

  it("counts the person's edits and not the interview's", async () => {
    const { repo, dir } = await withTwoNodes();
    const afterTwo = readTicket(dir, "PRB-1").admission.edit_count ?? 0;
    expect(afterTwo).toBeGreaterThan(0);
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" }, [
      "--author",
      "interview",
    ]);
    expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(afterTwo);
    expect(readDraftSnapshot(dir, "PRB-1")?.edits.at(-1)?.author).toBe("interview");
  });
});

describe("perbo edit --undo", () => {
  it("reverts one edit and leaves it in the log, marked undone", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    expect(await edit(repo, ["--undo", "3"])).toBe(EXIT_CODES.approve);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);
    const edits = readDraftSnapshot(dir, "PRB-1")?.edits ?? [];
    expect(edits[2]?.undone).toBe(true);
    expect(edits[2]?.summary).toContain("node_1 -> node_2");
    expect(edits.at(-1)?.undoes).toBe(3);
  });

  it("reverts a node to the value it had before the edit", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "set_node_paths", id: "node_2", paths: ["packages/reports/*"] });
    expect(planNodes(readContract(dir, "PRB-1"))[1]?.paths).toEqual(["packages/reports/*"]);
    await edit(repo, ["--undo", "3"]);
    expect(planNodes(readContract(dir, "PRB-1"))[1]?.paths).toEqual(["packages/reports/**"]);
  });

  it("is refused, naming the later edit, when a later one still in force touched the same key", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "set_node_paths", id: "node_2", paths: ["packages/reports/*"] });
    await graphEdit(repo, { op: "set_node_paths", id: "node_2", paths: ["packages/reports/**"] });
    const refused: unknown = await edit(repo, ["--undo", "3"]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("edit 4");
    expect((refused as UsageError).message).toContain("node_2");
    expect(planNodes(readContract(dir, "PRB-1"))[1]?.paths).toEqual(["packages/reports/**"]);

    // Undo the later one first, and the earlier is free again.
    expect(await edit(repo, ["--undo", "4"])).toBe(EXIT_CODES.approve);
    expect(await edit(repo, ["--undo", "3"])).toBe(EXIT_CODES.approve);
  });

  it("refuses to undo an undo, and says the way back is to apply the edit again", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    expect(await edit(repo, ["--undo", "3"])).toBe(EXIT_CODES.approve);
    const refused: unknown = await edit(repo, ["--undo", "4"]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toMatch(/undid edit 3[\s\S]*--graph-edit/);
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);
    expect(readDraftSnapshot(dir, "PRB-1")?.edits.map((entry) => entry.undone)).toEqual([false, false, true, false]);
  });

  it("refuses a number nothing answers to, and an edit already undone", async () => {
    const { repo } = await withTwoNodes();
    await expect(edit(repo, ["--undo", "9"])).rejects.toThrow(UsageError);
    await edit(repo, ["--undo", "2"]);
    await expect(edit(repo, ["--undo", "2"])).rejects.toThrow(/already undone/);
  });
});

describe("an approved plan", () => {
  it("takes an approach edit and refuses a contract one", async () => {
    const { repo, dir } = await withTwoNodes();
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    expect(
      runApproveCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo }),
    ).toBe(EXIT_CODES.approve);

    // Edges are approach: they may change while the work runs (ADR-0016).
    expect(await graphEdit(repo, { op: "remove_edge", from: "node_1", to: "node_2" })).toBe(
      EXIT_CODES.approve,
    );
    expect(readApproachRecord(dir, "PRB-1")?.edges).toEqual([]);

    // A node's criteria and paths are contract, and the contract is immutable.
    const refused: unknown = await graphEdit(repo, {
      op: "set_node_paths",
      id: "node_1",
      paths: ["packages/queue/**"],
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as UsageError).message).toContain("immutable");
  });
});
