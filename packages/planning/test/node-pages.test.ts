import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanContractSchema, type PlanContract } from "@perbo/contracts";
import { parseSpec, requirementNodes, writeNodePages, type Spec } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-node-pages-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A duplicate signup inside five minutes queues nothing.
- R4: A failed send is retried three times.
- R5: The queue reports how many are waiting.

## No-Gos

- Nothing is sent to an address that has unsubscribed.
- No change to the signup form.

## Rabbit holes

- Templating: the existing template stays.

## Notes

The queue package already has a sender.
`;

const spec: Spec = parseSpec(SPEC);

const contract = (over: Partial<Record<string, unknown>> = {}): PlanContract =>
  PlanContractSchema.parse({
    plan_id: "plan_0102030405060708",
    version: 1,
    ticket_id: "ticket_0102030405060708",
    level: "P1",
    outcome: "New users receive an activation email within 60 seconds of signing up.",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "A signup POST queues exactly one activation email.",
        expected_verification: { kind: "test", assertion: "one message is queued for one signup" },
        requirement_id: "R1",
      },
      {
        id: "ac_2",
        text: "A duplicate signup queues nothing.",
        expected_verification: { kind: "test", assertion: "a second signup queues nothing" },
        requirement_id: "R2",
      },
      {
        id: "ac_3",
        text: "A failed send is retried three times.",
        expected_verification: { kind: "test", assertion: "three attempts are recorded" },
        requirement_id: "R4",
      },
      {
        id: "ac_4",
        text: "A failed send is dead-lettered after the retries.",
        expected_verification: { kind: "artifact", assertion: "the dead-letter record exists" },
        requirement_id: "R4",
      },
    ],
    nodes: [
      { id: "node_1", title: "Queue the email", criteria: ["ac_1", "ac_2"], paths: ["packages/queue/**"] },
      {
        id: "node_2",
        title: "Retry a failed send",
        criteria: ["ac_3", "ac_4"],
        paths: ["packages/queue/**", "packages/auth/**"],
      },
    ],
    scope: {
      repository_id: "repo_webstore",
      paths_allowed: ["packages/queue/**", "packages/auth/**"],
      paths_prohibited: ["specs/**"],
      generated_paths: [],
      expansion_budget_files: 3,
    },
    base: {
      base_commit: "a1b2c3d",
      context_manifest_hash: `sha256:${"b".repeat(64)}`,
      captured_at: "2026-09-12T00:00:00.000Z",
    },
    ...over,
  });

let folders = 0;
const folder = (): string => {
  const path = join(scratch, `spec-${folders++}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "spec.md"), SPEC);
  return path;
};

describe("the node a requirement lands in", () => {
  it("is derived from the criteria drafted from it, with several where its criteria are split", () => {
    const split = contract({
      nodes: [
        { id: "node_1", title: "Queue the email", criteria: ["ac_1", "ac_2"], paths: ["packages/queue/**"] },
        { id: "node_2", title: "Retry", criteria: ["ac_3"], paths: ["packages/queue/**"] },
        { id: "node_3", title: "Dead-letter", criteria: ["ac_4"], paths: ["packages/auth/**"] },
      ],
    });
    expect(requirementNodes(spec, split)).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email.", nodes: ["node_1"] },
      { id: "R2", text: "A duplicate signup inside five minutes queues nothing.", nodes: ["node_1"] },
      { id: "R4", text: "A failed send is retried three times.", nodes: ["node_2", "node_3"] },
      { id: "R5", text: "The queue reports how many are waiting.", nodes: [] },
    ]);
  });

  it("is none at all before there is a contract, and none for a plan with no graph", () => {
    expect(requirementNodes(spec, null).map((each) => each.nodes)).toEqual([[], [], [], []]);
    const flat = contract({ nodes: undefined });
    expect(requirementNodes(spec, flat).map((each) => each.nodes)).toEqual([[], [], [], []]);
  });
});

describe("where a node's page is written", () => {
  /** A place outside every repository this file makes, for a link to point at. */
  const outside = (): string => mkdtempSync(join(tmpdir(), "perbo-node-pages-outside-"));

  it("refuses a nodes folder that is a symlink, so nothing is written outside the spec folder", () => {
    const specFolder = folder();
    const elsewhere = outside();
    symlinkSync(elsewhere, join(specFolder, "nodes"));
    expect(() => writeNodePages({ repositoryRoot: scratch, specFolder, spec, contract: contract() })).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "node_1.md"))).toBe(false);
  });

  it("refuses a spec folder that is a symlink, wherever on the way the link sits", () => {
    const repository = mkdtempSync(join(scratch, "repo-"));
    const elsewhere = outside();
    writeFileSync(join(elsewhere, "spec.md"), SPEC);
    mkdirSync(join(repository, "specs"), { recursive: true });
    symlinkSync(elsewhere, join(repository, "specs", "activation-email"));
    const specFolder = join(repository, "specs", "activation-email");
    expect(() =>
      writeNodePages({ repositoryRoot: repository, specFolder, spec, contract: contract() }),
    ).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "nodes"))).toBe(false);
  });

  it("refuses a page that is itself a symlink, rather than writing through it", () => {
    const specFolder = folder();
    const elsewhere = outside();
    writeFileSync(join(elsewhere, "target.md"), "# elsewhere\n");
    mkdirSync(join(specFolder, "nodes"), { recursive: true });
    symlinkSync(join(elsewhere, "target.md"), join(specFolder, "nodes", "node_1.md"));
    expect(() => writeNodePages({ repositoryRoot: scratch, specFolder, spec, contract: contract() })).toThrow(/symlink/);
    expect(readFileSync(join(elsewhere, "target.md"), "utf8")).toBe("# elsewhere\n");
  });

  it("refuses a spec folder outside the repository it is told about", () => {
    const specFolder = folder();
    const other = mkdtempSync(join(scratch, "other-"));
    expect(() =>
      writeNodePages({ repositoryRoot: other, specFolder, spec, contract: contract() }),
    ).toThrow(/outside/);
  });
});

describe("a node's page beside the spec", () => {
  it("carries the title, its requirements, its criteria and verification, its paths and the No-Gos", () => {
    const at = folder();
    const written = writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract() });
    expect(written.written).toEqual([join(at, "nodes", "node_1.md"), join(at, "nodes", "node_2.md")]);

    const page = readFileSync(join(at, "nodes", "node_2.md"), "utf8");
    expect(page).toContain("# Retry a failed send");
    expect(page).toContain("- R4: A failed send is retried three times.");
    // R1 belongs to node_1's criteria, so it is not on this page.
    expect(page).not.toContain("R1:");
    expect(page).toContain("ac_3");
    expect(page).toContain("three attempts are recorded");
    expect(page).toContain("artifact");
    expect(page).toContain("packages/auth/**");
    expect(page).toContain("Nothing is sent to an address that has unsubscribed.");
    expect(page).toContain("## Notes");
  });

  it("keeps a Notes section written by hand when it is regenerated", () => {
    const at = folder();
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract() });
    const path = join(at, "nodes", "node_1.md");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8").trimEnd()}\n\nThe sender in @queueSend already batches.\nTalk to Ana before touching the template.\n`,
    );

    const renamed = contract({
      nodes: [
        { id: "node_1", title: "Queue it once", criteria: ["ac_1", "ac_2"], paths: ["packages/queue/**"] },
        {
          id: "node_2",
          title: "Retry a failed send",
          criteria: ["ac_3", "ac_4"],
          paths: ["packages/queue/**", "packages/auth/**"],
        },
      ],
    });
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: renamed });
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# Queue it once");
    expect(after).toContain("The sender in @queueSend already batches.");
    expect(after).toContain("Talk to Ana before touching the template.");
    // Written once, not twice: regeneration replaces the generated part.
    expect(after.match(/## Notes/g)).toHaveLength(1);
    expect(after.match(/Talk to Ana/g)).toHaveLength(1);
  });

  it("removes the page of a node the plan no longer has", () => {
    const at = folder();
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract() });
    expect(existsSync(join(at, "nodes", "node_2.md"))).toBe(true);

    const merged = contract({
      nodes: [
        {
          id: "node_1",
          title: "All of it",
          criteria: ["ac_1", "ac_2", "ac_3", "ac_4"],
          paths: ["packages/queue/**"],
        },
      ],
    });
    const result = writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: merged });
    expect(result.removed).toEqual([join(at, "nodes", "node_2.md")]);
    expect(existsSync(join(at, "nodes", "node_2.md"))).toBe(false);
    expect(existsSync(join(at, "nodes", "node_1.md"))).toBe(true);
  });

  it("leaves no pages for a flat plan, and removes any the graph left behind", () => {
    const at = folder();
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract() });
    const result = writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract({ nodes: undefined }) });
    expect(result.written).toEqual([]);
    expect(result.removed).toHaveLength(2);
    expect(existsSync(join(at, "nodes", "node_1.md"))).toBe(false);
  });

  it("regenerates from the spec as it now stands, so an edited requirement reaches the page", () => {
    const at = folder();
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract() });
    const edited = parseSpec(SPEC.replace("- R4: A failed send is retried three times.", "- R4: A failed send is retried five times."));
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec: edited, contract: contract() });
    expect(readFileSync(join(at, "nodes", "node_2.md"), "utf8")).toContain(
      "- R4: A failed send is retried five times.",
    );
  });

  it("never touches a supporting file beside the spec", () => {
    const at = folder();
    mkdirSync(join(at, "nodes"), { recursive: true });
    writeFileSync(join(at, "nodes", "reading.txt"), "kept");
    writeFileSync(join(at, "measurements.md"), "kept too");
    writeNodePages({ repositoryRoot: scratch, specFolder: at, spec, contract: contract({ nodes: undefined }) });
    expect(readFileSync(join(at, "nodes", "reading.txt"), "utf8")).toBe("kept");
    expect(readFileSync(join(at, "measurements.md"), "utf8")).toBe("kept too");
  });
});
