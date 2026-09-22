import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { admitCommandLine } from "./admit.js";
import { editCommandLine } from "./edit/index.js";
import { inspectCommandLine, type InspectReport } from "./inspect.js";
import { storeDir } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-graph-test-"));
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
/** Twelve tracked files under one package, and one under another. */
function repository(): string {
  const repo = join(scratch, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, "packages", "queue", "src"), { recursive: true });
  for (let i = 1; i <= 12; i += 1) {
    writeFileSync(join(repo, "packages", "queue", "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }
  mkdirSync(join(repo, "packages", "queue", "test"), { recursive: true });
  writeFileSync(join(repo, "packages", "queue", "test", "send.test.ts"), "export {};\n");
  mkdirSync(join(repo, "packages", "reports", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "reports", "src", "daily.ts"), "export const daily = 1;\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: gitIdentity });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitIdentity });
  return repo;
}

function admitted(criteria: number, paths: string[]): string {
  const repo = repository();
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo,
      "--outcome", "New users receive an activation email.",
      ...Array.from({ length: criteria }, (_, i) => [
        "--criterion",
        `criterion ${i + 1} holds :: assertion ${i + 1}`,
      ]).flat(),
      ...paths.flatMap((path) => ["--path", path]),
    ],
    streams: recordStreams(),
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error("admission failed");
  return repo;
}

const graphEdit = (repo: string, edit: unknown) =>
  runCommandLine(editCommandLine, {
    argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edit)],
    streams: recordStreams(),
    cwd: repo,
  });

/** The rendering as a person reads it at 80 columns: colour stripped. */
async function inspectText(repo: string): Promise<string> {
  const streams = recordStreams({ isTTY: true });
  expect(await runCommandLine(inspectCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo })).toBe(0);
  return streams.plain();
}

async function inspectJson(repo: string): Promise<InspectReport> {
  const streams = recordStreams();
  expect(await runCommandLine(inspectCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo })).toBe(0);
  return streams.json<never>();
}

/** Two nodes over the two packages, ordered. */
async function graphed(): Promise<string> {
  const repo = admitted(4, ["packages/queue/**", "packages/reports/**"]);
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
      { title: "Queue the email", criteria: ["ac_1", "ac_2", "ac_3"], paths: ["packages/queue/src/**"] },
      { title: "Count them", criteria: ["ac_4"], paths: ["packages/reports/**"] },
    ],
  });
  await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
  return repo;
}

describe("perbo inspect on a plan with a graph", () => {
  it("lists each node with its criteria and paths, and the order between them", async () => {
    const text = await inspectText(await graphed());
    expect(text).toContain("node_1");
    expect(text).toContain("Queue the email");
    expect(text).toContain("ac_1, ac_2, ac_3");
    expect(text).toContain("packages/queue/src/**");
    expect(text).toContain("node_1 -> node_2");
  });

  it("names an approach record it could not read as this plan's, rather than showing no order", async () => {
    const repo = await graphed();
    const path = join(storeDir(repo, null), "tickets", "PRB-1.approach.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { plan_id: string };
    writeFileSync(path, JSON.stringify({ ...record, plan_id: "plan_00000000000000000000000000" }, null, 2));
    const text = await inspectText(repo);
    expect(text).toContain("node_1");
    expect(text).toMatch(/order {3}not read: PRB-1\.approach\.json names ticket/);
    expect(text).not.toContain("none suggested");
    const report = await inspectJson(repo);
    expect(report.edges).toBeNull();
    expect(String(report.approach_problem)).toContain("another plan's approach");
  });

  it("reports a size from fixed thresholds, marking the counts that set it", async () => {
    const repo = await graphed();
    const text = await inspectText(repo);
    // Two nodes (S allows 1), four criteria (S), thirteen files (M allows 25,
    // S allows 10), two packages (M): M, set by the nodes and the files.
    expect(text).toMatch(/Size M · 2 nodes\* · 4 criteria · 13 files\* · 2 packages\*/);
    const report = await inspectJson(repo);
    expect(report.size).toEqual({
      name: "M",
      counts: { nodes: 2, criteria: 4, files: 13, packages: 2 },
      drivers: ["nodes", "files", "packages"],
    });
  });

  it("carries the nodes and the edges in --json", async () => {
    const report = await inspectJson(await graphed());
    expect(report.nodes?.map((node) => node.id)).toEqual(["node_1", "node_2"]);
    expect(report.nodes?.[0]?.criteria).toEqual(["ac_1", "ac_2", "ac_3"]);
    expect(report.edges).toEqual([{ from: "node_1", to: "node_2" }]);
  });

  it("shows no graph section for a flat plan, and sizes it from its criteria and scope", async () => {
    const repo = admitted(2, ["packages/reports/**"]);
    const text = await inspectText(repo);
    expect(text).not.toContain("node_1");
    expect(text).toContain("Size S");
    const report = await inspectJson(repo);
    expect(report.nodes).toBeNull();
    expect(report.edges).toBeNull();
    // A flat plan is one node, over the whole scope it allows.
    expect(report.size?.counts).toEqual({ nodes: 1, criteria: 2, files: 1, packages: 1 });
  });

  it("leaves a prohibited path out of the files in scope", async () => {
    const repo = admitted(2, ["packages/queue/**"]);
    await runCommandLine(editCommandLine, {
      argv: ["PRB-1", "--repo", repo, "--path", "packages/queue/src/**"],
      streams: recordStreams(),
      cwd: repo,
    });
    const report = await inspectJson(repo);
    expect(report.size?.counts.files).toBe(12);
  });
});
