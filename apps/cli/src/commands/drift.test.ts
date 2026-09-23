import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, hasAcceptanceCriteria } from "@perbo/contracts";
import { SUBMIT_REVIEW_TOOL, type Model, type ModelRequest, type ModelTurn } from "@perbo/model";
import { DriftVerdictSchema, driftRecordPath, type DriftFinding } from "@perbo/planning";
import { initRepository } from "@perbo/test-support";
import { runCommandLine } from "../command-line/terminal.js";
import { readContract, storeDir } from "../store/tickets.js";
import { recordStreams } from "../test-support/streams.js";
import { UsageError } from "../usage-error.js";
import { admitCommandLine } from "./admit.js";
import { readDriftRecord } from "../store/drift.js";
import { driftCommandLine } from "./drift.js";
import { editCommandLine } from "./edit/index.js";

/**
 * `perbo drift`: the plan read against its spec, and the verdict kept beside
 * the ticket against the state it was read at.
 *
 * Nothing here calls a model. The reading is a scripted double, and the one
 * that must never be reached throws — a cache hit that quietly ran a model
 * would pass a test that only read the output.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-drift-test-"));
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

## Notes

The queue package already has a sender.
`;

let repos = 0;
function repository(): { repo: string; specPath: string } {
  const repo = join(scratch, `repo-${repos++}`);
  initRepository(repo, {
    files: {
      "specs/activation-email/spec.md": SPEC,
      "packages/queue/send.ts": "export const send = () => 1;\n",
    },
  });
  return { repo, specPath: join(repo, "specs", "activation-email", "spec.md") };
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
        toolCalls: calls.map((call, index) => ({ id: `t${turn}_${index}`, name: call.tool, input: call.input })),
        usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}
const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];

/** A model the command must not reach: a verdict it holds is printed, not read again. */
function unreachable(): Model {
  return {
    provider: "double",
    model_id: "unreachable",
    turn(): Promise<ModelTurn> {
      throw new Error("the model was called for a state whose verdict was already held");
    },
  };
}

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
  proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
  rationale: "The spec's three requirements fall into queueing and retrying.",
  depends_on: [],
  nodes: [
    { title: "Queue the email", criteria: [0, 1], paths: ["packages/queue/**"] },
    { title: "Retry a failed send", criteria: [2], paths: ["packages/queue/**"] },
  ],
  edges: [{ from: 0, to: 1 }],
};

const finding: DriftFinding = {
  heading: "Criterion 1 and R1",
  difference: "The spec asks for exactly one activation email; the plan promises exactly two.",
  options: [
    { label: "Reword criterion 1 to say exactly one activation email is queued.", detail: null, recommended: true },
    { label: "Change R1 in the spec to ask for exactly two activation emails.", detail: null, recommended: false },
  ],
};

async function admitFromSpec(repo: string, specPath: string, extra: string[] = []): Promise<void> {
  const streams = recordStreams();
  const code = await runCommandLine(admitCommandLine, {
    argv: ["--repo", repo, "--from-spec", specPath, ...extra],
    streams,
    cwd: repo,
    deps: { model: scripted([submits(drafted)]) },
  });
  if (code !== EXIT_CODES.approve) throw new Error(`admission failed:\n${streams.err()}`);
}

/** A ticket drafted from the spec, with its seeded verdict beside it. */
async function drafted1(): Promise<{ repo: string; specPath: string; dir: string }> {
  const { repo, specPath } = repository();
  await admitFromSpec(repo, specPath);
  return { repo, specPath, dir: storeDir(repo, null) };
}

const graphEdit = (repo: string, edit: unknown) =>
  runCommandLine(editCommandLine, {
    argv: ["PRB-1", "--repo", repo, "--graph-edit", JSON.stringify(edit)],
    streams: recordStreams(),
    cwd: repo,
  });

/** A person's own rewording of the first criterion, at the Graph pane. */
const reword = (repo: string, text: string) =>
  graphEdit(repo, {
    op: "set_criterion",
    id: "ac_1",
    text,
    expected_verification: { kind: "test", assertion: "one message is on the queue after a single signup" },
  });

const sha256 = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The two hashes as the contract states them, computed here from the files
 * rather than through the command's own helper, so the test and the code
 * can disagree.
 */
function expectedKey(repo: string, specPath: string): { spec: string; promises: string } {
  const contract = readContract(storeDir(repo, null), "PRB-1");
  const criteria = hasAcceptanceCriteria(contract)
    ? contract.acceptance_criteria.map((criterion) => criterion.text.trim()).sort()
    : [];
  return {
    spec: sha256(readFileSync(specPath)),
    promises: sha256(JSON.stringify([contract.outcome.trim(), ...criteria])),
  };
}

async function drift(repo: string, model: Model, extra: string[] = []) {
  const streams = recordStreams();
  const code = await runCommandLine(driftCommandLine, {
    argv: ["PRB-1", "--repo", repo, ...extra],
    streams,
    cwd: repo,
    now: new Date("2026-09-21T10:00:00.000Z"),
    deps: { model },
  });
  return { code, streams, verdict: DriftVerdictSchema.parse(streams.json()) };
}

describe("perbo drift's line", () => {
  it("takes the ticket, the repository, the model and the two flags", () => {
    expect(
      driftCommandLine.read([
        "PRB-3", "--repo", "..", "--store", "s", "--provider", "anthropic", "--model", "m", "--dismiss", "--json",
      ]),
    ).toEqual({
      input: { target: { repo: "..", store: "s" }, key: "PRB-3", provider: "anthropic", model: "m", dismiss: true },
      output: { json: true },
    });
    expect(driftCommandLine.read(["PRB-3"]).input.provider).toBe("claude-cli");
    expect(() => driftCommandLine.read([])).toThrow(UsageError);
    expect(() => driftCommandLine.read(["--json"])).toThrow(/ticket key/);
    expect(() => driftCommandLine.read(["PRB-3", "--provider", "gemini"])).toThrow(/claude-cli/);
    expect(() => driftCommandLine.read(["PRB-3", "--model"])).toThrow(/requires a value/);
    expect(() => driftCommandLine.read(["PRB-3", "--force"])).toThrow(/unknown flag/);
  });
});

describe("perbo drift", () => {
  it("is seeded by admission from a spec: a plan just drafted agrees with it", async () => {
    const { repo, specPath, dir } = await drafted1();
    const record = readDriftRecord(dir, "PRB-1");
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      ...expectedKey(repo, specPath),
      origin: "drafted",
      findings: [],
      dismissed: false,
      model: null,
    });
  });

  it("prints the verdict it holds and calls no model while neither the spec nor the plan moved", async () => {
    const { repo } = await drafted1();
    const { code, verdict } = await drift(repo, unreachable());
    expect(code).toBe(0);
    expect(verdict.key).toBe("PRB-1");
    expect(verdict.cached).toBe(true);
    expect(verdict.origin).toBe("drafted");
    expect(verdict.findings).toEqual([]);
    // `--json` is taken for parity and changes nothing: the output is the record either way.
    const again = await drift(repo, unreachable(), ["--json"]);
    expect(again.verdict).toEqual(verdict);
  });

  it("reads the plan with the model once a hand edit moved a promise, and holds that reading past an arrangement edit", async () => {
    const { repo, specPath, dir } = await drafted1();
    const seeded = readDriftRecord(dir, "PRB-1")!;
    await reword(repo, "A signup POST queues exactly two activation emails.");
    // The record is left where it was: nothing read the edit yet.
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);

    const model = scripted([submits({ findings: [finding] })]);
    const read = await drift(repo, model);
    expect(read.code).toBe(0);
    expect(read.verdict.cached).toBe(false);
    expect(read.verdict.origin).toBe("read");
    expect(read.verdict.findings).toEqual([finding]);
    expect(read.verdict.model?.prompt_version).toBe("drift_v1");
    expect(model.requests).toHaveLength(1);
    // The model saw the words as they now stand, and the spec as it is.
    const user = String(model.requests[0]!.messages[0]!.content);
    expect(user).toContain("exactly two activation emails");
    expect(user).toContain("R1: A signup POST queues exactly one activation email.");
    // Kept against the state that was read.
    const moved = expectedKey(repo, specPath);
    expect(moved.promises).not.toBe(seeded.promises);
    expect(readDriftRecord(dir, "PRB-1")).toMatchObject({ ...moved, origin: "read", findings: [finding] });

    // An arrangement edit moves neither hash: the reading holds, and no model runs.
    await graphEdit(repo, { op: "remove_edge", from: "node_1", to: "node_2" });
    const held = await drift(repo, unreachable());
    expect(held.verdict.cached).toBe(true);
    expect(held.verdict.origin).toBe("read");
    expect(held.verdict.findings).toEqual([finding]);
    await graphEdit(repo, { op: "add_edge", from: "node_1", to: "node_2" });
    expect((await drift(repo, unreachable())).verdict.cached).toBe(true);
  });

  it("lets a hand edit of the spec go, and reads again", async () => {
    const { repo, specPath, dir } = await drafted1();
    writeFileSync(specPath, SPEC.replace("exactly one activation email", "exactly two activation emails"));
    const read = await drift(repo, scripted([submits({ findings: [finding] })]));
    expect(read.verdict.cached).toBe(false);
    expect(read.verdict.spec).toBe(sha256(readFileSync(specPath)));
    expect(readDriftRecord(dir, "PRB-1")).toMatchObject({ ...expectedKey(repo, specPath), origin: "read" });
    // A spec put back to the words it had is a state nothing read: the seed
    // was overwritten, so the model runs again rather than a stale record
    // being taken for it.
    writeFileSync(specPath, SPEC);
    expect((await drift(repo, scripted([submits({ findings: [] })]))).verdict.cached).toBe(false);
  });

  it("with --dismiss records going on with the differences open, at this state and no other", async () => {
    const { repo, dir } = await drafted1();
    await reword(repo, "A signup POST queues exactly two activation emails.");
    await drift(repo, scripted([submits({ findings: [finding] })]));

    const dismissed = await drift(repo, unreachable(), ["--dismiss"]);
    expect(dismissed.code).toBe(0);
    expect(dismissed.verdict.dismissed).toBe(true);
    expect(dismissed.verdict.cached).toBe(true);
    expect(dismissed.verdict.findings).toEqual([finding]);
    expect(readDriftRecord(dir, "PRB-1")?.dismissed).toBe(true);
    // Still held, still dismissed, on the next visit.
    expect((await drift(repo, unreachable())).verdict.dismissed).toBe(true);

    // The state moved: what was dismissed was a reading of other words.
    await reword(repo, "A signup POST queues exactly three activation emails.");
    await expect(drift(repo, unreachable(), ["--dismiss"])).rejects.toThrow(UsageError);
    await expect(drift(repo, unreachable(), ["--dismiss"])).rejects.toThrow(/nothing has been read at this state/);
    expect(readDriftRecord(dir, "PRB-1")?.dismissed).toBe(true);
    const read = await drift(repo, scripted([submits({ findings: [] })]));
    expect(read.verdict.cached).toBe(false);
    expect(read.verdict.dismissed).toBe(false);
  });

  it("is seeded again by a re-draft from the spec", async () => {
    const { repo, specPath, dir } = await drafted1();
    await reword(repo, "A signup POST queues exactly two activation emails.");
    await drift(repo, scripted([submits({ findings: [finding] })]));
    await admitFromSpec(repo, specPath, ["--start-over", "PRB-1"]);
    expect(readDriftRecord(dir, "PRB-1")).toMatchObject({
      ...expectedKey(repo, specPath),
      origin: "drafted",
      findings: [],
      dismissed: false,
    });
    expect((await drift(repo, unreachable())).verdict.cached).toBe(true);
  });

  it("refuses a ticket not drafted from a spec", async () => {
    const { repo } = repository();
    const code = await runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo,
        "--outcome", "New users receive an activation email.",
        "--criterion", "one email is queued :: a single signup queues one message",
        "--path", "packages/queue/**",
      ],
      streams: recordStreams(),
      cwd: repo,
    });
    expect(code).toBe(EXIT_CODES.approve);
    await expect(drift(repo, unreachable())).rejects.toThrow(UsageError);
    await expect(drift(repo, unreachable())).rejects.toThrow(/not drafted from a spec/);
  });

  it("refuses a spec it cannot read, and a record that is not one, naming each", async () => {
    const { repo, specPath, dir } = await drafted1();
    writeFileSync(driftRecordPath(dir, "PRB-1"), '{"spec": "not a hash"}\n');
    await expect(drift(repo, unreachable())).rejects.toThrow(UsageError);
    await expect(drift(repo, unreachable())).rejects.toThrow(/PRB-1\.drift\.json is not a drift record/);
    rmSync(specPath);
    await expect(drift(repo, unreachable())).rejects.toThrow(/cannot be read now/);
  });
});
