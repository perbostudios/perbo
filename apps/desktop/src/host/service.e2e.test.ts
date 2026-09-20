import { interviewSessionArgs } from "../shared/contract-editing.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopService, type ServiceOptions } from "./service.js";
import { runProcess, startLineProcess } from "./process.js";
import { GRAPH_NODE_STATES, SettingsSchema } from "../shared/protocol.js";
import { lane } from "../shared/jobs.js";
import type {
  Change,
  Draft,
  InterviewEntry,
  Job,
  SpecSections,
  SpecView,
} from "../shared/protocol.js";
import { CriterionEvidenceBindingSchema } from "@perbo/contracts";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import { disposeFixtures, fixture, trackDirectory, trackService } from "./test-support/host-fixture.js";

afterEach(disposeFixtures);

const draft: Draft = {
  outcome: "Make errors actionable $(touch should-not-exist) `whoami`",
  criteria: [
    {
      text: "The user can retry",
      assertion: "The retry button is visible after failure",
      kind: "test",
    },
  ],
  paths: ["src/**", "test/**"],
  prohibited: [],
};
/**
 * Save a spec having read it first, which is what the Spec pane does: a save
 * says what it last read, and a section somebody else wrote meanwhile comes
 * back rather than being overwritten (SCP-321). The tests that are about that
 * refusal hold an older base on purpose and call `request` themselves.
 */
async function saveSpec(
  service: DesktopService,
  request: { kind: "specSave"; id: string; repoId: string; title: string; sections: SpecSections },
): Promise<SpecView> {
  const read = await service.request({ kind: "specRead", id: request.id });
  const reply = await service.request({
    ...request,
    base: { title: read.title, sections: read.sections },
  });
  if (reply.conflicting.length > 0)
    throw new Error(`the spec moved under this save: ${reply.conflicting.join(", ")}`);
  return reply.view;
}
async function finished(service: DesktopService, id: string): Promise<Job> {
  for (let count = 0; count < 200; count++) {
    const job = (await service.snapshot()).jobs.find(
      (entry) => entry.id === id,
    )!;
    if (!["running", "stopping"].includes(job.state)) return job;
    await delay(20);
  }
  throw new Error("Desktop command did not settle");
}
/**
 * SCP-336: the Spec pane writes the spec into the repository through the host,
 * and the node pages beside it follow the spec as well as the graph (D-103).
 */
describe("the spec a planning session holds", () => {
  const sections = {
    outcome: "The application supports a usable light colour mode.",
    requirements:
      "- The person can choose Light, Dark or System without a restart.\n" +
      "- Text meets WCAG AA contrast against its background.",
    no_gos: "- Changing the brand colours.",
    rabbit_holes: "",
    notes: "",
  };

  it("rewrites the node pages when the spec is saved, and names each requirement's node", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    // A graph built the one way a graph is built, through the CLI's edit path.
    execFileSync(
      globalThis.process.execPath,
      [
        resolve("../cli/dist/perbo.js"), "edit", "PRB-1", "--repo", repo,
        "--graph-edit",
        JSON.stringify({ op: "add_node", title: "The palette", criteria: ["ac_1"], paths: ["src/**"] }),
      ],
      { stdio: "ignore" },
    );
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: registered.id, key: "PRB-1" },
    });
    const written = await saveSpec(service, {
      kind: "specSave", id: session.id, repoId: registered.id,
      title: "A light colour mode", sections,
    });
    // No criterion cites a requirement of this spec, so none has landed anywhere.
    expect(written.requirements.every((each) => each.nodes.length === 0)).toBe(true);

    const page = readFileSync(
      join(repo, "specs", "a-light-colour-mode", "nodes", "node_1.md"),
      "utf8",
    );
    expect(page).toContain("# The palette");
    expect(page).toContain("ac_1");
    // The No-Gos on the page come from the spec that was just saved.
    expect(page).toContain("Changing the brand colours.");

    // Editing the spec alone rewrites the page: it states what the spec says.
    await saveSpec(service, {
      kind: "specSave", id: session.id, repoId: registered.id,
      title: "A light colour mode",
      sections: { ...sections, no_gos: "- Changing the brand colours.\n- A high-contrast mode." },
    });
    expect(
      readFileSync(join(repo, "specs", "a-light-colour-mode", "nodes", "node_1.md"), "utf8"),
    ).toContain("A high-contrast mode.");
  });
});

/**
 * SCP-321: the names the Spec pane completes `@Symbol` from, and marks against,
 * come from `perbo index` run by the host over the registered repository
 * (D-015). Nothing a renderer sent reaches the command
 * ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) §4): the
 * request carries a repository id and gets back a list.
 */
describe("the exported names a planning session completes from", () => {
  it("answers what the repository exports, with the commit the index was built at", async () => {
    const { service, repo } = fixture();
    writeFileSync(
      join(repo, "signup.ts"),
      "export function signup(): void {}\nexport const MAX_ATTEMPTS = 3;\n",
    );
    execFileSync("git", ["add", "signup.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "Add signup"], { cwd: repo, stdio: "ignore" });
    const registered = await service.registerRepository(repo);

    const answer = await service.request({ kind: "symbolIndex", repoId: registered.id });
    if (!answer.supported) throw new Error(`expected an index: ${answer.reason}`);
    expect(answer.names).toEqual([
      { name: "signup", kind: "function", path: "signup.ts" },
      { name: "MAX_ATTEMPTS", kind: "variable", path: "signup.ts" },
    ]);
    // The stamp is the checkout's own head, which is what makes the answer
    // something a person can compare against what they are looking at.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(head.startsWith(answer.headCommit)).toBe(true);
    expect(answer.workingTree).toBe("clean");
  });

  it("says a repository it cannot describe is one, rather than answering no names", async () => {
    // The fixture tracks a README and nothing else: there is nothing here to
    // check a spec's names against, which is not the same as every name having
    // gone, and the pane marks nothing rather than marking everything.
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const answer = await service.request({ kind: "symbolIndex", repoId: registered.id });
    expect(answer.supported).toBe(false);
    if (answer.supported) throw new Error("expected no index");
    expect(answer.reason).toContain("no tracked TypeScript or JavaScript");
    expect(answer.languages).toEqual([".md"]);
  });
});

/**
 * SCP-316: the Graph pane curates the plan through the one validated edit path
 * (D-100). Every edit the pane makes is `perbo edit --graph-edit` run by the
 * host, with `--author` naming who made it; the pane never writes the contract
 * or the approach record itself.
 */
describe("the graph a planning session curates", () => {
  const twoCriteria: Draft = {
    outcome: "New users receive an activation email",
    criteria: [
      { text: "A signup queues one email", assertion: "signup.test.ts", kind: "test" },
      { text: "A failed send is retried", assertion: "retry.test.ts", kind: "test" },
    ],
    paths: ["packages/auth/**", "packages/queue/**"],
    prohibited: [],
  };
  /** A ticket in plan_review whose plan has no graph yet. */
  async function admitted(runner?: typeof runProcess) {
    const made = fixture(runner);
    const registered = await made.service.registerRepository(made.repo);
    await finished(
      made.service,
      (await made.service.request({ kind: "admit", repoId: registered.id, draft: twoCriteria })).id,
    );
    return { ...made, repoId: registered.id };
  }
  const cli = (repo: string, args: string[]): void => {
    execFileSync(globalThis.process.execPath, [resolve("../cli/dist/perbo.js"), ...args, "--repo", repo], {
      stdio: "ignore",
    });
  };

  it("runs one operation through the CLI with its author, and moves the admission count", async () => {
    const invocations: string[][] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "edit") invocations.push([...args]);
      return runProcess(binary, args, options);
    };
    const { service, repo, repoId } = await admitted(runner);
    const before = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(before.nodes).toHaveLength(0);
    expect(before.editCount).toBe(0);

    const job = await finished(
      service,
      (
        await service.request({
          kind: "graphEdit",
          repoId,
          key: "PRB-1",
          edit: {
            op: "add_node",
            title: "Queue one email",
            criteria: ["ac_1"],
            new_criteria: [],
            paths: ["packages/auth/**"],
          },
        })
      ).id,
    );
    expect(job.state).toBe("completed");
    const invoked = invocations.at(-1)!;
    expect(invoked).toContain("--graph-edit");
    expect(invoked.slice(invoked.indexOf("--author"), invoked.indexOf("--author") + 2)).toEqual([
      "--author",
      "you",
    ]);

    // What the CLI wrote, not what the pane thinks: the files on disk.
    const contract: unknown = JSON.parse(
      readFileSync(join(repo, ".perbo", "tickets", "PRB-1.contract.json"), "utf8"),
    );
    expect((contract as { nodes: { id: string }[] }).nodes.map((node) => node.id)).toEqual([
      "node_1",
      "node_2",
    ]);
    const after = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(after.nodes.map((node) => node.title)).toEqual(["Queue one email", twoCriteria.outcome]);
    expect(after.editCount).toBeGreaterThan(before.editCount);
    expect(after.history.at(-1)).toMatchObject({ n: 1, author: "you", undone: false });

    // An edge is approach, and reaches the record beside the ticket.
    await finished(
      service,
      (
        await service.request({
          kind: "graphEdit",
          repoId,
          key: "PRB-1",
          edit: { op: "add_edge", from: "node_1", to: "node_2" },
        })
      ).id,
    );
    const approach: unknown = JSON.parse(
      readFileSync(join(repo, ".perbo", "tickets", "PRB-1.approach.json"), "utf8"),
    );
    expect((approach as { edges: unknown[] }).edges).toEqual([{ from: "node_1", to: "node_2" }]);
    expect((await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).edges).toEqual([
      { from: "node_1", to: "node_2" },
    ]);
  });

  it("shows both authors' edits in one history, and undoes the latest through --undo", async () => {
    const invocations: string[][] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "edit") invocations.push([...args]);
      return runProcess(binary, args, options);
    };
    const { service, repo, repoId } = await admitted(runner);
    // The interview's edit goes through the same command, as D-100 requires.
    cli(repo, [
      "edit",
      "PRB-1",
      "--author",
      "interview",
      "--graph-edit",
      JSON.stringify({ op: "add_node", title: "Queue one email", criteria: ["ac_1"], paths: ["packages/auth/**"] }),
    ]);
    await finished(
      service,
      (
        await service.request({
          kind: "graphEdit",
          repoId,
          key: "PRB-1",
          edit: { op: "set_node_paths", id: "node_1", paths: ["packages/auth/**", "packages/queue/**"] },
        })
      ).id,
    );
    const both = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(both.history.map((edit) => edit.author)).toEqual(["interview", "you"]);
    // Only the person's edits count as admission friction (D-072).
    expect(both.editCount).toBe(1);

    const undone = await finished(
      service,
      (await service.request({ kind: "graphUndo", repoId, key: "PRB-1", edit: 2 })).id,
    );
    expect(undone.state).toBe("completed");
    expect(invocations.at(-1)).toContain("--undo");
    const after = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(after.nodes[0]?.paths).toEqual(["packages/auth/**"]);
    expect(after.history[1]?.undone).toBe(true);
    expect(after.history.at(-1)).toMatchObject({ undoes: 2, author: "you" });
  });

  it("reads the size from the graph, and the node's generated page beside it", async () => {
    const { service, repo, repoId } = await admitted();
    mkdirSync(join(repo, "packages", "auth"), { recursive: true });
    writeFileSync(join(repo, "packages", "auth", "signup.ts"), "export const signup = 1;\n");
    execFileSync("git", ["add", "packages/auth/signup.ts"], { cwd: repo });
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId, key: "PRB-1" },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId,
      title: "Activation email",
      sections: {
        outcome: "New users receive an activation email.",
        requirements: "- A signup queues one email.",
        no_gos: "- No change to the signup form.",
        rabbit_holes: "",
        notes: "",
      },
    });
    // A ticket with no spec has no generated page, and the pane shows none.
    expect(
      (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).nodes.every(
        (node) => node.page === null,
      ),
    ).toBe(true);
    // The record `admit --from-spec` leaves on a ticket drafted from a spec,
    // written here because drafting one spends against a model.
    const ticketPath = join(repo, ".perbo", "tickets", "PRB-1.json");
    const specPath = "specs/activation-email/spec.md";
    const stored = JSON.parse(readFileSync(ticketPath, "utf8")) as {
      admission: Record<string, unknown>;
    };
    stored.admission["spec"] = {
      path: specPath,
      content_sha256: `sha256:${createHash("sha256")
        .update(readFileSync(join(repo, specPath), "utf8"), "utf8")
        .digest("hex")}`,
    };
    writeFileSync(ticketPath, JSON.stringify(stored, null, 2));

    await finished(
      service,
      (
        await service.request({
          kind: "graphEdit",
          repoId,
          key: "PRB-1",
          edit: {
            op: "add_node",
            title: "Queue one email",
            criteria: ["ac_1"],
            new_criteria: [],
            paths: ["packages/auth/**"],
          },
        })
      ).id,
    );
    const view = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(view.size.counts).toMatchObject({ nodes: 2, criteria: 2, files: 1 });
    expect(view.size.name).toBe("M");
    const page = view.nodes[0]?.page;
    expect(page?.path).toBe("specs/activation-email/nodes/node_1.md");
    expect(page?.text).toContain("# Queue one email");
    expect(page?.text).toContain("No change to the signup form.");
  });

  it("carries no path across the boundary that nothing reads, and no file list at all", async () => {
    const { service, repo, repoId } = await admitted();
    mkdirSync(join(repo, "secrets"), { recursive: true });
    writeFileSync(join(repo, ".env.production"), "TOKEN=shhh\n");
    writeFileSync(join(repo, "deploy.pem"), "-----BEGIN-----\n");
    writeFileSync(join(repo, "secrets", "db.txt"), "shhh\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const view = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    const wire = JSON.stringify(view);
    for (const hidden of [".env.production", "deploy.pem", "secrets/db.txt"])
      expect(wire, hidden).not.toContain(hidden);
    expect(view).not.toHaveProperty("files");
  });

  it("opens planning mode over a ticket in plan_review, and refuses one that has moved on", async () => {
    const { service, repo, repoId } = await admitted();
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId, key: "PRB-1" },
    });
    expect(session.key).toBe("PRB-1");
    cli(repo, ["approve", "PRB-1"]);
    await expect(
      service.request({ kind: "editingOpen", target: { kind: "planning", repoId, key: "PRB-1" } }),
    ).rejects.toThrow(/ready/);
  });
});

/**
 * SCP-317: what the run's own records say about the graph, read from the store
 * and from nothing the executor wrote about itself (D-100, ADR-0023).
 */
describe("the graph while the work runs", () => {
  const twoCriteria: Draft = {
    outcome: "New users receive an activation email",
    criteria: [
      { text: "A signup queues one email", assertion: "signup.test.ts", kind: "test" },
      { text: "A failed send is retried", assertion: "retry.test.ts", kind: "test" },
    ],
    paths: ["packages/auth/**", "packages/queue/**"],
    prohibited: [],
  };
  /** A ticket whose plan has two nodes, one path glob each. */
  async function graphed() {
    const made = fixture();
    const registered = await made.service.registerRepository(made.repo);
    const repoId = registered.id;
    await finished(
      made.service,
      (await made.service.request({ kind: "admit", repoId, draft: twoCriteria })).id,
    );
    for (const edit of [
      {
        op: "add_node",
        title: "Queue one email",
        criteria: ["ac_1"],
        new_criteria: [],
        paths: ["packages/auth/**"],
      },
      { op: "set_node_paths", id: "node_2", paths: ["packages/queue/**"] },
    ] as GraphEdit[])
      await finished(
        made.service,
        (await made.service.request({ kind: "graphEdit", repoId, key: "PRB-1", edit })).id,
      );
    const ticketId = (
      JSON.parse(readFileSync(join(made.repo, ".perbo", "tickets", "PRB-1.json"), "utf8")) as {
        ticket_id: string;
      }
    ).ticket_id;
    return { ...made, repoId, ticketId };
  }

  /**
   * The records one attempt leaves, written where the loop writes them: the
   * attempts file under `.perbo/state`, and content-addressed bundle
   * artifacts under `.perbo/bundles`. Written by hand because running an
   * executor spends money; every byte is the shape the loop seals.
   */
  function record(
    repo: string,
    ticketId: string,
    input: {
      attemptId: string;
      artifacts: { name: string; body: string }[];
      review?: { body: string; createdAt: string };
      account?: string;
      /** The change set this attempt sealed, which a review has to be about. */
      changesetId?: string;
      /** The plan the ticket now carries, where a re-draft has moved it on. */
      planVersion?: number;
      /** The closure verifications, as remediation rounds record them. */
      closed?: { attemptId: string; keys: string[]; createdAt: string }[];
    },
  ): void {
    const objects = join(repo, ".perbo", "bundles", "objects");
    const manifests = join(repo, ".perbo", "bundles", "bundles");
    mkdirSync(objects, { recursive: true });
    mkdirSync(manifests, { recursive: true });
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    const put = (entries: { name: string; body: string }[]) =>
      entries.map((entry) => {
        const bytes = Buffer.from(entry.body, "utf8");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        writeFileSync(join(objects, sha256), bytes);
        return { name: entry.name, sha256, bytes: bytes.length, retained: true };
      });
    writeFileSync(
      join(manifests, `bundle_${createHash("sha256").update(input.attemptId).digest("hex").slice(0, 16)}.json`),
      JSON.stringify({
        bundle_id: `bundle_${createHash("sha256").update(input.attemptId).digest("hex").slice(0, 16)}`,
        kind: "execution",
        created_at: "2026-09-10T10:00:00.000Z",
        subject_id: input.attemptId,
        ticket_id: ticketId,
        artifacts: put(input.artifacts),
      }),
    );
    if (input.review)
      writeFileSync(
        join(manifests, "bundle_00000000000000ab.json"),
        JSON.stringify({
          bundle_id: "bundle_00000000000000ab",
          kind: "review",
          created_at: input.review.createdAt,
          subject_id: "rev_one",
          ticket_id: ticketId,
          artifacts: put([{ name: "review.json", body: input.review.body }]),
        }),
      );
    for (const [at, closure] of (input.closed ?? []).entries())
      writeFileSync(
        join(manifests, `bundle_00000000000000c${at}.json`),
        JSON.stringify({
          bundle_id: `bundle_00000000000000c${at}`,
          kind: "verification",
          created_at: closure.createdAt,
          subject_id: `cv_${closure.attemptId}`,
          ticket_id: ticketId,
          inputs: { findings_closed: closure.keys.join(",") },
          artifacts: [],
        }),
      );
    if (input.planVersion !== undefined) {
      const path = join(repo, ".perbo", "tickets", "PRB-1.json");
      const ticket = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...ticket, plan_version: input.planVersion }));
    }
    writeFileSync(
      join(repo, ".perbo", "state", `${ticketId}.attempts.json`),
      JSON.stringify({
        ticket_id: ticketId,
        attempts: [
          {
            attempt_id: input.attemptId,
            created_at: "2026-09-10T10:00:00.000Z",
            changeset_id: input.changesetId ?? "cs_0000000000000001",
            branch: "prb/activation",
            ...(input.account ? { executor_account: input.account } : {}),
          },
        ],
      }),
    );
  }

  const binding = (
    id: string,
    status: "met" | "not_met" | "cannot_determine",
    file: string,
    line: number,
  ) =>
    CriterionEvidenceBindingSchema.parse({
      criterion_id: id,
      status,
      verification_strength: status === "met" ? "directly_verified" : "asserted_only",
      evidence: { type: "test_result", ref: "unit", assertion: "it holds", location: { file, line, symbol: null } },
      note: null,
    });

  it("gives each node its changed paths and each criterion the state its record supports", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    // A plan that has never run: no attempt, every node untouched, nothing outside.
    const before = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    expect(before.attempt).toBeNull();
    expect(before.nodes.map((node) => node.state)).toEqual(["untouched", "untouched"]);
    expect(before.nodes.flatMap((node) => node.changed)).toEqual([]);
    expect(before.outside).toEqual([]);
    expect(before.nodes[1]?.criteria).toEqual([
      { id: "ac_2", state: "unbound", strength: null, evidence: null, finding: null },
    ]);

    record(repo, ticketId, {
      attemptId: "att_0000000000000001",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts\n" +
            "--- a/packages/auth/signup.ts\n+++ b/packages/auth/signup.ts\n@@ -1 +1,2 @@\n+queue(email);\n" +
            "diff --git a/docs/activation.md b/docs/activation.md\n" +
            "--- a/docs/activation.md\n+++ b/docs/activation.md\n@@ -1 +1,2 @@\n+A note nobody planned for.\n",
        },
        {
          name: "checks.json",
          body: JSON.stringify([
            { check_id: "check_unit", name: "Tests", kind: "unit", status: "passed", summary: "186 passed" },
            {
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "passed",
              summary: "12 passed",
              node: { node_id: "node_1", scope: "files", paths: ["packages/auth/signup.test.ts"], note: null },
            },
            // The loop runs every pinned check once per node, for every node,
            // so a node the change never reached gets the whole command back:
            // it passes, and it is not evidence about that node.
            {
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "passed",
              summary: "186 passed",
              node: {
                node_id: "node_2",
                scope: "task",
                paths: [],
                note: "the change touched no file inside the node's paths",
              },
            },
          ]),
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_1", "met", "packages/auth/signup.test.ts", 12)],
          findings: [],
        }),
      },
    });

    const view = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    const live = view.live;
    expect(live.attempt).toBe("att_0000000000000001");
    const first = live.nodes.find((node) => node.id === "node_1")!;
    const second = live.nodes.find((node) => node.id === "node_2")!;
    expect(first.changed).toEqual(["packages/auth/signup.ts"]);
    expect(first.state).toBe("covered");
    expect(first.checks).toEqual([{ name: "Tests", status: "passed" }]);
    expect(first.criteria).toEqual([
      {
        id: "ac_1",
        state: "met",
        strength: "directly_verified",
        evidence: "packages/auth/signup.test.ts:12",
        finding: null,
      },
    ]);
    expect(second.changed).toEqual([]);
    expect(second.state).toBe("untouched");
    expect(second.criteria).toEqual([
      { id: "ac_2", state: "unbound", strength: null, evidence: null, finding: null },
    ]);
    // The path no node's globs match is work nobody planned for, and is said so.
    expect(live.outside).toEqual(["docs/activation.md"]);
    expect(live.note).toBeNull();

    // The acceptance criterion: the executor's own account of itself, on disk,
    // in the two places it reaches a record — and the reply is the same reply.
    record(repo, ticketId, {
      attemptId: "att_0000000000000001",
      account:
        "Every acceptance criterion is complete and directly verified. ac_2 is met by " +
        "packages/queue/retry.test.ts. Nothing outside the plan was touched.",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts\n" +
            "--- a/packages/auth/signup.ts\n+++ b/packages/auth/signup.ts\n@@ -1 +1,2 @@\n+queue(email);\n" +
            "diff --git a/docs/activation.md b/docs/activation.md\n" +
            "--- a/docs/activation.md\n+++ b/docs/activation.md\n@@ -1 +1,2 @@\n+A note nobody planned for.\n",
        },
        {
          name: "checks.json",
          body: JSON.stringify([
            { check_id: "check_unit", name: "Tests", kind: "unit", status: "passed", summary: "186 passed" },
            {
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "passed",
              summary: "12 passed",
              node: { node_id: "node_1", scope: "files", paths: ["packages/auth/signup.test.ts"], note: null },
            },
          ]),
        },
        {
          name: "transcript.jsonl",
          body: JSON.stringify({
            role: "assistant",
            text:
              "ALL ACCEPTANCE CRITERIA VERIFIED. ac_1 met, ac_2 met, node_2 complete, " +
              "every check passed, no path outside the plan.",
          }),
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_1", "met", "packages/auth/signup.test.ts", 12)],
          findings: [],
        }),
      },
    });
    expect((await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live).toEqual(live);
  });

  it("keeps the review through a remediation round, which seals a new change set and is not reviewed again", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    // D-061: a remediation round is verified, not reviewed again, so it seals a
    // change set the review on record never judged and no newer review appears.
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      changesetId: "cs_0000000000000002",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts\n" +
            "--- a/packages/auth/signup.ts\n+++ b/packages/auth/signup.ts\n@@ -1 +1,2 @@\n+queue(one);\n",
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          plan_version: 1,
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_1", "met", "packages/auth/signup.test.ts", 12)],
          findings: [],
        }),
      },
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    const first = live.nodes.find((node) => node.id === "node_1")!;
    expect(first.criteria.map((criterion) => criterion.state)).toEqual(["met"]);
    expect(first.state).toBe("covered");
  });

  it("leaves out a review of a plan the spec has been re-drafted past", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    // A re-draft renumbers criteria, so a review of the plan before it is not
    // about these criteria however well the ids happen to line up.
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      planVersion: 2,
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts\n" +
            "--- a/packages/auth/signup.ts\n+++ b/packages/auth/signup.ts\n@@ -1 +1,2 @@\n+queue(one);\n",
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          plan_version: 1,
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_1", "met", "packages/auth/signup.test.ts", 12)],
          findings: [],
        }),
      },
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    const first = live.nodes.find((node) => node.id === "node_1")!;
    expect(first.criteria.map((criterion) => criterion.state)).toEqual(["unbound"]);
    expect(first.state).toBe("changed");
    expect(live.note).toMatch(/re-drafted|plan/i);
  });

  it("takes a finding a later round closed as closed", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/queue/retry.ts b/packages/queue/retry.ts\n" +
            "--- a/packages/queue/retry.ts\n+++ b/packages/queue/retry.ts\n@@ -1 +1,2 @@\n+retry(three);\n",
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_2", "met", "packages/queue/retry.test.ts", 88)],
          findings: [
            {
              key: "e".repeat(64),
              rule_id: "product.dead_letter",
              criterion_id: "ac_2",
              severity: "major",
              status: "open",
              statement: "A permanently failed send has nowhere to go.",
            },
          ],
        }),
      },
      // The remediation round that closed it, recorded where the loop records it.
      // Two rounds, each closing its own finding: a round's list names only
      // what that round closed, so the earlier one has to be read as well.
      closed: [
        { attemptId: "att_0000000000000002", keys: ["e".repeat(64)], createdAt: "2026-09-10T10:10:00.000Z" },
        { attemptId: "att_0000000000000003", keys: ["f".repeat(64)], createdAt: "2026-09-10T10:20:00.000Z" },
      ],
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    const second = live.nodes.find((node) => node.id === "node_2")!;
    expect(second.criteria[0]?.finding).toBeNull();
    expect(second.state).not.toBe("finding_open");
  });

  it("does not let an older round's closure answer a finding a later review raised again", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    // A finding key is derived from the rule, the criterion and the place, so
    // the same fault found again carries the same key as one closed before.
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/queue/retry.ts b/packages/queue/retry.ts\n" +
            "--- a/packages/queue/retry.ts\n+++ b/packages/queue/retry.ts\n@@ -1 +1,2 @@\n+retry(three);\n",
        },
      ],
      closed: [
        { attemptId: "att_0000000000000001", keys: ["e".repeat(64)], createdAt: "2026-09-10T09:00:00.000Z" },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          plan_version: 1,
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_2", "not_met", "packages/queue/retry.test.ts", 88)],
          findings: [
            {
              key: "e".repeat(64),
              rule_id: "product.dead_letter",
              criterion_id: "ac_2",
              severity: "major",
              status: "open",
              statement: "A permanently failed send has nowhere to go.",
            },
          ],
        }),
      },
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    const second = live.nodes.find((node) => node.id === "node_2")!;
    expect(second.criteria[0]?.finding).toBe("A permanently failed send has nowhere to go.");
    expect(second.state).toBe("finding_open");
  });

  it("says a failed node check, a node the review has not covered, and an open finding", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts\n" +
            "--- a/packages/auth/signup.ts\n+++ b/packages/auth/signup.ts\n@@ -1 +1,2 @@\n+queue(email);\n" +
            "diff --git a/packages/queue/retry.ts b/packages/queue/retry.ts\n" +
            "--- a/packages/queue/retry.ts\n+++ b/packages/queue/retry.ts\n@@ -1 +1,2 @@\n+retry(3);\n",
        },
        {
          name: "checks.json",
          body: JSON.stringify([
            {
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "passed",
              summary: "12 passed",
              node: { node_id: "node_1", scope: "files", paths: ["packages/auth/signup.test.ts"], note: null },
            },
            {
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "failed",
              summary: "1 failed",
              node: { node_id: "node_2", scope: "files", paths: ["packages/queue/retry.test.ts"], note: null },
            },
          ]),
        },
      ],
      review: {
        createdAt: "2026-09-10T10:05:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          target: { type: "changeset", id: "cs_0000000000000001" },
          created_at: "2026-09-10T10:05:00.000Z",
          coverage: [binding("ac_2", "not_met", "packages/queue/retry.test.ts", 88)],
          findings: [
            {
              key: "e".repeat(64),
              rule_id: "product.dead_letter",
              criterion_id: "ac_2",
              severity: "major",
              status: "open",
              statement: "A permanently failed send has nowhere to go.",
            },
          ],
        }),
      },
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    // Every state the host derives is one the protocol declares (SCP-317).
    for (const node of live.nodes) expect(GRAPH_NODE_STATES).toContain(node.state);
    // Changed, its own check passed, and the review has said nothing about its criterion.
    const first = live.nodes.find((node) => node.id === "node_1")!;
    expect(first.state).toBe("checks_passed");
    expect(first.criteria[0]?.state).toBe("unbound");
    // A finding open against its criterion outranks the check that failed under it.
    const second = live.nodes.find((node) => node.id === "node_2")!;
    expect(second.state).toBe("finding_open");
    expect(second.checks).toEqual([{ name: "Tests", status: "failed" }]);
    expect(second.criteria[0]).toEqual({
      id: "ac_2",
      state: "not_met",
      strength: "asserted_only",
      evidence: "packages/queue/retry.test.ts:88",
      finding: "A permanently failed send has nowhere to go.",
    });
    expect(live.outside).toEqual([]);
  });

  it("says a check that failed where the review left no finding, and a withheld diff", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    record(repo, ticketId, {
      attemptId: "att_0000000000000003",
      artifacts: [
        {
          name: "checks.json",
          body: JSON.stringify([
            {
              // Narrowable, because only a unit run is: a typecheck node run is
              // always the whole command, and the whole command is not evidence
              // about one node (D-107).
              check_id: "check_unit",
              name: "Tests",
              kind: "unit",
              status: "failed",
              summary: "2 failed",
              node: { node_id: "node_1", scope: "files", paths: ["packages/auth/signup.test.ts"], note: null },
            },
          ]),
        },
      ],
    });
    const live = (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live;
    // A sealed change set whose bytes are not on hand says so rather than
    // reading as a node nobody touched.
    expect(live.note).toMatch(/change set/i);
    expect(live.nodes.find((node) => node.id === "node_1")?.state).toBe("checks_failed");
    expect(live.outside).toEqual([]);
  });

  it("shows a flat plan's run with nothing outside, because it has no node to be outside of", async () => {
    const { service, repo, repoId, ticketId } = await graphed();
    for (const id of ["node_2", "node_1"])
      await finished(
        service,
        (
          await service.request({
            kind: "graphEdit",
            repoId,
            key: "PRB-1",
            edit: {
              op: "delete_node",
              id,
              move_criteria_to: id === "node_2" ? "node_1" : null,
              delete_criteria: [],
            },
          })
        ).id,
      );
    record(repo, ticketId, {
      attemptId: "att_0000000000000004",
      artifacts: [
        {
          name: "change.diff",
          body:
            "diff --git a/docs/activation.md b/docs/activation.md\n" +
            "--- a/docs/activation.md\n+++ b/docs/activation.md\n@@ -1 +1,2 @@\n+A note.\n",
        },
      ],
    });
    const view = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(view.nodes).toHaveLength(0);
    expect(view.live.nodes).toEqual([]);
    expect(view.live.outside).toEqual([]);
  });
});

describe("desktop bridge against the actual bundled CLI", () => {
  it("shares native snapshot, detail and output reads while preserving repository scope", async () => {
    const calls: string[] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      calls.push(binary === "git" ? args.join(" ") : args[1]!);
      return runProcess(binary, args, options);
    };
    const { service, repo } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    calls.length = 0;
    const [first, second, detail, output] = await Promise.all([
      service.snapshot(), service.snapshot(), service.detail(registered.id, "PRB-1"),
      service.request({ kind: "output", repoId: registered.id, key: "PRB-1" }),
    ]);
    expect(first.tasks).toEqual(second.tasks);
    expect(detail.ticket.key).toBe("PRB-1");
    expect(output).toEqual({ transcript: null, diff: null, notes: [] });
    expect(calls.filter((call) => call === "list")).toHaveLength(1);
    expect(calls.filter((call) => call === "inspect")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("--no-optional-locks"))).toHaveLength(1);
    expect(calls.filter((call) => call === "rev-parse HEAD")).toHaveLength(1);
  });

  it("refreshes a native detail read that overlaps a CLI edit", async () => {
    let held: (() => void) | undefined, holdNext = false;
    let markReadHeld!: () => void;
    const readHeld = new Promise<void>((resolve) => { markReadHeld = resolve; });
    const runner: typeof runProcess = async (binary, args, options) => {
      const result = await runProcess(binary, args, options);
      if (holdNext && args[1] === "list") {
        holdNext = false;
        await new Promise<void>((resolve) => { held = resolve; markReadHeld(); });
      }
      return result;
    };
    const { service, repo, options } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const initial = await service.detail(registered.id, "PRB-1");
    holdNext = true;
    const reading = service.detail(registered.id, "PRB-1");
    try {
      await readHeld;
      const settled = new Promise<void>((resolve) => {
        options.changed = (change) => {
          if (change.kind === "records" && change.job?.kind === "edit") resolve();
        };
      });
      const job = await service.request({ kind: "edit", repoId: registered.id, key: "PRB-1", digest: initial.digest, draft: { ...draft, outcome: "The newer saved contract" } });
      await settled;
      expect(job.state).toBe("completed");
    } finally {
      held?.();
    }
    const latest = await reading;
    expect(latest.contract.outcome).toBe("The newer saved contract");
    expect(latest.contract.version).toBe(latest.ticket.plan_version);
  });

  it("recovers incomplete editing fields from disk and retains admission ownership beyond the job journal", async () => {
    const runner: typeof runProcess = async (binary, args, options) => args[1] === "doctor"
      ? { code: 0, stdout: "{}", stderr: "", cancelled: false }
      : runProcess(binary, args, options);
    const { service, repo, options } = fixture(runner);
    const registered = await service.registerRepository(repo);
    const initial = await service.request({ kind: "editingOpen", target: { kind: "new", repoId: registered.id } });
    const form = { ...initial.form, draft, editing: 0, criterion: { text: "Unfinished", assertion: "", kind: "query" as const }, newPath: "packages/", models: { ...initial.form.models, executorModel: "saved-model" } };
    const saved = await service.request({ kind: "editingSave", id: initial.id, revision: initial.revision, repoId: registered.id, form });
    await service.shutdown();
    const restarted = trackService(new DesktopService(options));
    const recovered = await restarted.request({ kind: "editingOpen", target: { kind: "new", repoId: registered.id } });
    expect(recovered).toEqual(saved);
    expect((await restarted.snapshot()).tasks).toHaveLength(0);
    expect(statSync(join(options.dataDirectory, "workspace.json")).mode & 0o777).toBe(0o600);
    const compiling = await restarted.request({ kind: "editingSave", id: saved.id, revision: saved.revision, repoId: registered.id, form: { ...form, editing: null, newPath: null } });
    const operationId = randomUUID();
    const settled = new Promise<void>((resolve) => {
      options.changed = (change) => {
        if (change.kind === "records" && change.job?.editing?.operationId === operationId) resolve();
      };
    });
    await restarted.request({ kind: "editingSubmit", id: saved.id, revision: compiling.revision, operationId, intent: "compile" });
    await settled;
    expect(await restarted.request({ kind: "editingRead", id: saved.id })).toMatchObject({ phase: "ready", key: "PRB-1" });
    for (let count = 0; count < 41; count++) {
      const job = await restarted.request({ kind: "doctor", repoId: registered.id, writeConfig: false });
      await vi.waitFor(() => expect(job.state).toBe("completed"), { interval: 5 });
    }
    expect((await restarted.snapshot()).jobs.some((job) => job.kind === "admit")).toBe(false);
    await restarted.shutdown();
    const again = trackService(new DesktopService(options));
    const receipt = await again.request({ kind: "editingSubmit", id: saved.id, revision: compiling.revision, operationId, intent: "compile" });
    expect(receipt).toMatchObject({ key: "PRB-1", phase: "ready", operation: { state: "completed", resultKey: "PRB-1" } });
    expect((await again.snapshot()).tasks).toHaveLength(1);
    const contract = await again.detail(registered.id, "PRB-1");
    expect(contract.ticket.approved_at).toBeNull();
    expect(contract.contract.outcome).toBe(draft.outcome);
  });

  it("keeps local edits when the CLI changes the saved contract", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const initial = await service.request({ kind: "editingOpen", target: { kind: "ticket", repoId: registered.id, key: "PRB-1" } });
    const local = await service.request({ kind: "editingSave", id: initial.id, revision: initial.revision, repoId: registered.id, form: { ...initial.form, draft: { ...draft, outcome: "Local unfinished text" } } });
    await finished(service, (await service.request({ kind: "edit", repoId: registered.id, key: "PRB-1", digest: initial.digest!, draft: { ...draft, outcome: "Changed through CLI authority" } })).id);
    const reopened = await service.request({ kind: "editingOpen", target: { kind: "session", id: initial.id } });
    expect(reopened).toMatchObject({ phase: "conflict", form: local.form, digest: initial.digest });
    await expect(service.request({ kind: "editingSubmit", id: local.id, revision: reopened.revision, operationId: randomUUID(), intent: "compile" })).rejects.toThrow(/Restore/);
  });

  it.each([false, true])("checks the selected Codex providers through a private host config (write: %s)", async (writeConfig) => {
    const invocations: Array<{ args: readonly string[]; path: string; config: unknown; mode: number }> = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "doctor") {
        const path = args[args.indexOf("--config") + 1]!;
        invocations.push({
          args,
          path,
          config: JSON.parse(readFileSync(path, "utf8")) as unknown,
          mode: statSync(path).mode & 0o777,
        });
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, options } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await service.request({
      kind: "saveSettings",
      settings: SettingsSchema.parse({
        executorProvider: "codex-cli",
        executorModel: "gpt-5.6-terra",
        reviewerProvider: "codex-cli",
        reviewerModel: "gpt-6-astra",
      }),
    });
    const job = await finished(service, (await service.request({
      kind: "doctor",
      repoId: registered.id,
      writeConfig,
    })).id);
    expect(job.state).toBe("completed");
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    expect(dirname(invocation.path)).toBe(options.dataDirectory);
    expect(invocation.mode).toBe(0o600);
    expect(invocation.config).toEqual({
      agent_binary: "codex",
      agent_provider: "codex-cli",
      model: "gpt-5.6-terra",
      reviewer_provider: "codex-cli",
      reviewer_model: "gpt-6-astra",
    });
    expect(invocation.args).toEqual([
      options.cliPath,
      "doctor",
      "--json",
      "--config",
      invocation.path,
      ...(writeConfig ? ["--write-config"] : []),
      "--repo",
      registered.path,
    ]);
  });

  it("admits, lists, inspects and edits a native ticket without running a provider", async () => {
    const { service } = fixture();
    const repo = await service.request({ kind: "chooseRepository" });
    expect(repo?.name).toBe("repository with spaces");
    const admitted = await finished(
      service,
      (await service.request({ kind: "admit", repoId: repo!.id, draft })).id,
    );
    expect(admitted.error).toBeNull();
    expect(admitted.resultKey).toBe("PRB-1");
    const detail = await service.request({
      kind: "detail",
      repoId: repo!.id,
      key: "PRB-1",
    });
    expect(detail.contract.outcome).toBe(draft.outcome);
    expect(detail.ticket.approved_at).toBeNull();
    expect(detail.attempts).toEqual([]);
    const edited = await finished(
      service,
      (
        await service.request({
          kind: "edit",
          repoId: repo!.id,
          key: "PRB-1",
          digest: detail.digest,
          draft: { ...draft, outcome: "Show a helpful retry action" },
        })
      ).id,
    );
    expect(edited.state).toBe("completed");
    const stale = await finished(
      service,
      (
        await service.request({
          kind: "edit",
          repoId: repo!.id,
          key: "PRB-1",
          digest: detail.digest,
          draft,
        })
      ).id,
    );
    expect(stale.state).toBe("failed");
    expect(stale.error).toContain("changed since");
  });
  it("reserves the exclusive lane before awaiting the child, and admits two contracts in turn", async () => {
    const { service } = fixture();
    const repo = await service.request({ kind: "chooseRepository" });
    const first = await service.request({
      kind: "sync",
      repoId: repo!.id,
      key: "PRB-1",
    });
    await expect(
      service.request({ kind: "sync", repoId: repo!.id, key: "PRB-1" }),
    ).rejects.toThrow("Refresh delivery from GitHub is already running");
    await finished(service, first.id);
    // Planning is the other lane: both are accepted at once, and the store still hands out two keys.
    const admitted = await Promise.all([
      service.request({ kind: "admit", repoId: repo!.id, draft }),
      service.request({
        kind: "admit",
        repoId: repo!.id,
        draft: { ...draft, outcome: "A second outcome admitted beside it" },
      }),
    ]);
    const settled = await Promise.all(
      admitted.map((job) => finished(service, job.id)),
    );
    expect(settled.map((job) => job.state)).toEqual(["completed", "completed"]);
    expect(settled.map((job) => job.resultKey).sort()).toEqual([
      "PRB-1",
      "PRB-2",
    ]);
  });
  it("preserves kill switches, tightens limits, selects Codex and requires explicit publication", async () => {
    let override: Record<string, unknown> | null = null;
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "run") {
        override = JSON.parse(
          readFileSync(args[args.indexOf("--config") + 1]!, "utf8"),
        ) as Record<string, unknown>;
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo } = fixture(runner),
      registered = await service.registerRepository(repo);
    const admitted = await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    expect(admitted.state).toBe("completed");
    writeFileSync(
      join(repo, ".perbo", "config.json"),
      JSON.stringify({
        publish: true,
        merge: "loop",
        limits: {
          organisation: "test",
          limits: { attempt_commands: 4, attempt_wall_clock_ms: 60_000 },
          kill_switches: { global_read_only: true },
        },
      }),
    );
    await service.request({
      kind: "saveSettings",
      settings: SettingsSchema.parse({
        executorProvider: "codex-cli",
        executorModel: "gpt-5.6-terra",
        executorSkills: ["codebase-design"],
        reviewerProvider: "claude-cli",
      }),
    });
    const detail = await service.detail(registered.id, "PRB-1");
    const ran = await finished(
      service,
      (
        await service.request({
          kind: "run",
          repoId: registered.id,
          key: "PRB-1",
          digest: detail.digest,
          approve: true,
          publish: false,
          resumeFrom: null,
        })
      ).id,
    );
    expect(ran.error).toBeNull();
    expect(override).toMatchObject({
      agent_binary: "codex",
      agent_provider: "codex-cli",
      executor_skills: ["codebase-design"],
      publish: false,
      merge: "person",
      limits: {
        limits: { attempt_commands: 4, attempt_wall_clock_ms: 60_000 },
        kill_switches: { global_read_only: true },
      },
    });
    expect(
      (await service.detail(registered.id, "PRB-1")).ticket.approved_at,
    ).not.toBeNull();
    const forbidden = await finished(
      service,
      (
        await service.request({
          kind: "edit",
          repoId: registered.id,
          key: "PRB-1",
          digest: detail.digest,
          draft,
        })
      ).id,
    );
    expect(forbidden.state).toBe("failed");
  });
  it("edits the actual manifest, preserves commands and refuses a stale save", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    mkdirSync(join(repo, ".perbo"));
    const configPath = join(repo, ".perbo", "config.json");
    const config = {
      publish: false,
      protected_paths: ["infra/**"],
      materialization_manifest: {
        manifest_version: 1,
        repository_id: "repo_0000000000000001",
        source_checkout: repo,
        entries: [],
        install: {
          kind: "none",
          package_manager: "none",
          offline_preferred: true,
          lifecycle_scripts: { policy: "disabled", exception: null },
          command: ["true"],
          pinned: true,
        },
        verify: { command: ["node", "--test"], timeout_ms: 1000 },
        isolation: {
          mode: "serialized",
          port_range_size: 0,
          port_range_start: 20000,
          port_range_end: 21000,
          database_schema_prefix: null,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const opened = await service.request({
      kind: "manifest",
      repoId: registered.id,
    });
    expect(opened.testCommand).toBe("node --test");
    const value = {
      ...opened.value,
      offLimits: ["infra/**", "migrations/**"],
      entries: [
        {
          path: ".env.local",
          source_path: ".env.local",
          kind: "file" as const,
          strategy: "copy" as const,
          secret: true,
          required: true,
          reason: "Local configuration",
        },
      ],
    };
    await service.request({
      kind: "saveManifest",
      repoId: registered.id,
      digest: opened.digest,
      value,
    });
    const reopened = await service.request({
      kind: "manifest",
      repoId: registered.id,
    });
    expect(reopened.value).toEqual(value);
    expect(reopened.testCommand).toBe("node --test");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      publish: false,
      materialization_manifest: {
        install: config.materialization_manifest.install,
      },
    });
    await expect(
      service.request({
        kind: "saveManifest",
        repoId: registered.id,
        digest: opened.digest,
        value: opened.value,
      }),
    ).rejects.toThrow("configuration changed");
  });
  it("opens and saves off-limits paths where nothing names a package manager", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    mkdirSync(join(repo, ".perbo"));
    // A pinned manifest of the kind `--write-config` writes for such a
    // repository: an install that installs nothing, and `git status
    // --porcelain` as the verification.
    writeFileSync(
      join(repo, ".perbo", "config.json"),
      JSON.stringify({
        publish: false,
        materialization_manifest: {
          manifest_version: 1,
          repository_id: "repo_0000000000000001",
          source_checkout: ".",
          entries: [],
          install: {
            kind: "none",
            package_manager: "none",
            offline_preferred: false,
            lifecycle_scripts: { policy: "disabled", exception: null },
            command: ["true"],
            pinned: true,
          },
          verify: {
            command: ["git", "status", "--porcelain"],
            timeout_ms: 900_000,
          },
          isolation: {
            mode: "parallel",
            port_range_size: 10,
            port_range_start: 41000,
            port_range_end: 41009,
            database_schema_prefix: null,
          },
        },
      }),
    );
    const opened = await service.request({
      kind: "manifest",
      repoId: registered.id,
    });
    expect(opened.testCommand).toBe("git status --porcelain");
    expect(opened.value.entries).toEqual([]);
    await service.request({
      kind: "saveManifest",
      repoId: registered.id,
      digest: opened.digest,
      value: { ...opened.value, offLimits: ["infra/**"] },
    });
    const reopened = await service.request({
      kind: "manifest",
      repoId: registered.id,
    });
    expect(reopened.value.offLimits).toEqual(["infra/**"]);
  });
  it("refuses unknown operations and symlink ticket stores", async () => {
    const { service, repo, root } = fixture();
    await expect(
      service.request({ kind: "shell", command: "touch surprise" } as never),
    ).rejects.toThrow();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".perbo"));
    await expect(service.registerRepository(repo)).rejects.toThrow("symlink");
  });
});
/**
 * The explorer's reads (SCP-318). A renderer names a repository and a
 * repository-relative path; the host resolves it under the registered
 * repository through `safePath` and the never-read list, and refuses anything
 * else with the reason. Nothing here is editable: the reply carries text.
 */
describe("the explorer's host reads", () => {
  function stocked() {
    const state = fixture();
    const { repo } = state;
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "index.ts"), "export const answer = 42;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "Stock the explorer"], { cwd: repo, stdio: "ignore" });
    return state;
  }

  it("answers a read while an exclusive command holds the repository", async () => {
    const { service, repo } = stocked();
    const registered = await service.registerRepository(repo);
    expect(lane("explorerRead")).toBe("planning");
    expect(lane("explorerList")).toBe("planning");
    const doctor = await service.request({
      kind: "doctor",
      repoId: registered.id,
      writeConfig: false,
    });
    try {
      const file = await service.request({
        kind: "explorerRead",
        repoId: registered.id,
        path: "src/index.ts",
      });
      expect(file.text).toBe("export const answer = 42;\n");
    } finally {
      await finished(service, doctor.id);
    }
  });
});

/**
 * The explorer's marks through the host (SCP-318). A mark is the draft's own
 * scope, which admission passes as `--path` and `--prohibit`; the always box is
 * the repository's standing list in `.perbo/config.json` (D-105), written with
 * the draft that added the entry and taken off again by undo.
 */
describe("the explorer's marks through the host", () => {
  it("carries a prohibited path into the admitted contract's scope", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const job = await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, prohibited: ["src/generated/**"] },
        })
      ).id,
    );
    expect(job.state).toBe("completed");
    const detail = await service.detail(registered.id, "PRB-1");
    expect(detail.contract.scope.paths_prohibited).toContain("src/generated/**");
    expect(detail.contract.scope.paths_allowed).toEqual(["src/**", "test/**"]);
  });
});

/**
 * SCP-313: `perbo interview` relayed to planning mode's chat (D-102).
 *
 * The interview here is a fake binary speaking the JSON-line protocol, put in
 * place of the bundled CLI for the `interview` subcommand alone; every other
 * command still runs the real one. What is under test is the host: the argv it
 * builds from the registered repository and the session's own records, the
 * events it relays, the turn it writes down the child's stdin, and the plan
 * edit it reads off the store rather than off the session's account of itself.
 */
describe("the interview docked beside the panes", () => {
  const SECTIONS = {
    outcome: "New users receive an activation email within 60 seconds.",
    requirements: "- A signup queues one email.\n- A failed send is retried.",
    no_gos: "- Changing the sender address.",
    rabbit_holes: "",
    notes: "",
  };
  const twoCriteria: Draft = {
    outcome: "New users receive an activation email",
    criteria: [
      { text: "A signup queues one email", assertion: "signup.test.ts", kind: "test" },
      { text: "A failed send is retried", assertion: "retry.test.ts", kind: "test" },
    ],
    paths: ["packages/auth/**", "packages/queue/**"],
    prohibited: [],
  };
  const cli = (repo: string, args: string[]): void => {
    // Standard error is kept and put on the failure: an exit code says a
    // command failed and only this says why, which is what a test reading
    // "Command failed" alone has to guess.
    try {
      execFileSync(globalThis.process.execPath, [resolve("../cli/dist/perbo.js"), ...args, "--repo", repo], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      const said = String((error as { stderr?: Buffer }).stderr ?? "").trim();
      throw new Error(`${(error as Error).message}${said ? `\n${said}` : ""}`, { cause: error });
    }
  };

  /**
   * The fake interview: it prints `started`, answers each turn with a message,
   * and prints a refusal, an unreadable line or a `tool` event where the turn
   * asks for one. Its argv and every turn it was handed are written down, so
   * the test reads what the host actually spawned and actually sent.
   */
  function fakeInterview(root: string): { binary: string; argv: string; turns: string } {
    const binary = join(root, "fake-interview.cjs");
    const argv = join(root, "argv.json");
    const turns = join(root, "turns.jsonl");
    writeFileSync(
      binary,
      String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
send({ type: 'started', session_id: 'sdk-session-1', spec: 'specs/activation-email/spec.md',
  adr: 'docs/adr', model: null, tools: ['generate_plan', 'edit_plan', 'undo_edit', 'read_plan'] });
readline.createInterface({ input: process.stdin })
  .on('line', (line) => {
    fs.appendFileSync(${JSON.stringify(turns)}, line + '\n');
    const turn = JSON.parse(line);
    if (turn.text.includes('run the tests'))
      send({ type: 'refused', tool: 'Bash', rule: 'allow_list', target: 'pnpm test',
        reason: 'pnpm test is not one of the read-only shapes this session may run' });
    if (turn.text.includes('write the README'))
      send({ type: 'refused', tool: 'Write', rule: 'paths_allowed', target: 'README.md',
        reason: 'README.md is outside the spec folder, CONTEXT.md and the ADR folder' });
    if (turn.text.includes('gibberish')) process.stdout.write('not json at all\n');
    if (turn.text.includes('a long session'))
      send({ type: 'started', session_id: 's'.repeat(400), spec: 'specs/x/spec.md', adr: 'docs/adr',
        model: null, tools: [] });
    if (turn.text.includes('many keys')) {
      const many = { type: 'started', session_id: 's', spec: 's', adr: 'd', model: null, tools: [] };
      // The reason names the keys, so the credential is one of them.
      many['sk-ant-notreal0123456789'] = 'x';
      for (let at = 0; at < 900; at += 1) many['unrecognised_key_' + at] = 'x';
      send(many);
    }
    if (turn.text.includes('split the node'))
      send({ type: 'tool', tool: 'edit_plan', ok: true, detail: 'PRB-1: edit 2 — an edit' });
    send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You said: ' + turn.text }] } } });
  })
  .on('close', () => { send({ type: 'ended', session_id: 'sdk-session-1', reason: 'the session ended' }); });
`,
      { mode: 0o700 },
    );
    return { binary, argv, turns };
  }

  /** One planning session with a spec and a plan, and a fake interview in place of the CLI's. */
  async function planning(): Promise<{
    service: DesktopService;
    repo: string;
    /** The repository as it was registered, which is the path the argv carries. */
    registered: string;
    repoId: string;
    id: string;
    fake: { binary: string; argv: string; turns: string };
    changes: Change[];
    options: ServiceOptions;
  }> {
    const root = trackDirectory(mkdtempSync(join(tmpdir(), "perbo-interview-")));
    const fake = fakeInterview(root);
    const spawns: typeof startLineProcess = (binary, args, options) =>
      startLineProcess(
        binary,
        args[1] === "interview" ? [fake.binary, ...args.slice(1)] : [...args],
        options,
      );
    const made = fixture(undefined, spawns);
    const changes: Change[] = [];
    made.options.changed = (change) => changes.push(change);
    const registered = await made.service.registerRepository(made.repo);
    await finished(
      made.service,
      (await made.service.request({ kind: "admit", repoId: registered.id, draft: twoCriteria })).id,
    );
    // Planning mode over the ticket, with the spec this interview writes: a
    // session holding both is what the chat's cards and its undo need.
    const session = await made.service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId: registered.id, key: "PRB-1" },
    });
    await saveSpec(made.service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "Activation email",
      sections: SECTIONS,
    });
    return {
      service: made.service,
      repo: made.repo,
      registered: registered.path,
      repoId: registered.id,
      id: session.id,
      fake,
      changes,
      options: made.options,
    };
  }

  /** The interview, once its own `started` event has reached the record. */
  async function running(service: DesktopService, id: string): Promise<void> {
    for (let count = 0; count < 400; count++) {
      if ((await service.request({ kind: "editingRead", id })).interviewSession !== null) return;
      await delay(10);
    }
    throw new Error("The interview never reported a session");
  }

  /** The conversation, once it says what the test is waiting for. */
  async function spoken(
    service: DesktopService,
    id: string,
    holds: (lines: InterviewEntry[]) => boolean,
  ): Promise<InterviewEntry[]> {
    for (let count = 0; count < 400; count++) {
      const lines = (await service.request({ kind: "editingRead", id })).conversation;
      if (holds(lines)) return lines;
      await delay(10);
    }
    throw new Error("The interview never said what the test was waiting for");
  }
  /** Retry an assertion while the child is still on its way out. */
  async function waitFor(holds: () => Promise<void>): Promise<void> {
    for (let count = 0; count < 400; count++) {
      try {
        await holds();
        return;
      } catch {
        await delay(10);
      }
    }
    await holds();
  }
  const kinds = (lines: InterviewEntry[]): string[] => lines.map((line) => line.line.kind);
  const relayed = (changes: Change[]): InterviewEntry[] =>
    changes.flatMap((change) =>
      change.kind === "interview" && change.entry !== null ? [change.entry] : [],
    );

  it("names the spec from the person's first turn when the planning has none", async () => {
    const { service, repoId, fake } = await planning();
    const fresh = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    expect(fresh.specSlug).toBeNull();

    await service.request({ kind: "interviewTurn", id: fresh.id, text: "Can you add a dark mode toggle" });
    await running(service, fresh.id);

    // The person's own words named the folder, and the argv is still derived
    // from the recorded slug rather than from anything a renderer sent.
    expect((await service.request({ kind: "editingRead", id: fresh.id })).specSlug).toBe(
      "add-a-dark-mode-toggle",
    );
    const argv = JSON.parse(readFileSync(fake.argv, "utf8")) as string[];
    expect(argv.slice(argv.indexOf("--spec"), argv.indexOf("--spec") + 2)).toEqual([
      "--spec",
      "specs/add-a-dark-mode-toggle",
    ]);
    // The naming is said, and the turn it came from is part of the conversation.
    const lines = await spoken(service, fresh.id, (entries) =>
      entries.some(
        (entry) => entry.line.kind === "note" && entry.line.text.includes("Named from your first message"),
      ),
    );
    expect(kinds(lines)).toContain("turn");
    await service.request({ kind: "interviewStop", id: fresh.id });
  });

  it("relays each event in order and writes the person's turn to the child's stdin", async () => {
    const { service, repoId, id, fake, changes } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    const lines = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said"),
    );
    // The turn went down stdin as one `turn` line, and nothing else did.
    expect(readFileSync(fake.turns, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { type: "turn", text: "why two nodes?" },
    ]);
    expect(kinds(lines)).toEqual(["note", "turn", "said"]);
    expect(lines.map((line) => line.n)).toEqual([1, 2, 3]);
    // The snapshot says this planning has one, and stops saying so once it has
    // gone: it is counted where it is held, not read off a cached listing.
    expect((await service.snapshot()).interviews).toEqual([id]);
    const said = lines[2]!.line;
    expect(said.kind === "said" && said.text).toBe("You said: why two nodes?");
    // And each of them reached the renderer's change stream, in the same order.
    expect(relayed(changes).map((entry) => entry.n)).toEqual([1, 2, 3]);
    expect(kinds(relayed(changes))).toEqual(["note", "turn", "said"]);
    await service.request({ kind: "interviewStop", id });
    await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text.includes("ended")),
    );
    await waitFor(async () => expect((await service.snapshot()).interviews).toEqual([]));
  });

  it("shows a command it may not run and a write it may not make as refused", async () => {
    const { service, repoId, id, changes } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "please run the tests" });
    await service.request({ kind: "interviewTurn", id, text: "please write the README" });
    const lines = await spoken(
      service,
      id,
      (entries) => entries.filter((entry) => entry.line.kind === "refused").length === 2,
    );
    const refusals = lines.flatMap((entry) => (entry.line.kind === "refused" ? [entry.line] : []));
    expect(refusals.map((refusal) => refusal.tool)).toEqual(["Bash", "Write"]);
    expect(refusals[0]).toMatchObject({ rule: "allow_list", target: "pnpm test" });
    expect(refusals[1]).toMatchObject({ rule: "paths_allowed", target: "README.md" });
    expect(refusals[1]!.reason).toContain("outside the spec folder");
    // Each reached the renderer as a refusal rather than as a question.
    expect(relayed(changes).filter((entry) => entry.line.kind === "refused")).toHaveLength(2);
    await service.request({ kind: "interviewStop", id });
  });

  it("says so rather than relaying a line it cannot read", async () => {
    const { service, repoId, id } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "talk gibberish at me" });
    const lines = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text.includes("could not read")),
    );
    const note = lines.find(
      (entry) => entry.line.kind === "note" && entry.line.text.includes("could not read"),
    )!;
    expect(note.line.kind === "note" && note.line.text).toContain("not JSON");
    // The line itself is not carried anywhere: it is reported, not relayed.
    for (const entry of lines) expect(JSON.stringify(entry)).not.toContain("not json at all");
    await service.request({ kind: "interviewStop", id });
  });

  it("keeps the conversation on the record, so leaving and restarting come back to it", async () => {
    const { service, repoId, id, options } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    await spoken(service, id, (entries) => entries.some((entry) => entry.line.kind === "said"));
    await service.shutdown();

    // A restart: a fresh host over the same profile, with nothing running.
    const restarted = trackService(new DesktopService(options));
    const session = await restarted.request({ kind: "editingRead", id });
    expect(kinds(session.conversation)).toEqual(["note", "turn", "said"]);
    expect(session.interviewSession).toBe("sdk-session-1");
    expect((await restarted.snapshot()).interviews).toEqual([]);
  });

  it("undoes the interview's edit and leaves the edit made by hand standing", async () => {
    const { service, repo, repoId, id, changes } = await planning();
    // One edit by hand, through the pane's own request.
    await finished(
      service,
      (
        await service.request({
          kind: "graphEdit",
          repoId,
          key: "PRB-1",
          edit: {
            op: "add_node",
            title: "Queue one email",
            criteria: ["ac_1"],
            new_criteria: [],
            paths: ["packages/auth/**"],
          },
        })
      ).id,
    );
    // And one from the interview, through the same validated path with its own author.
    cli(repo, [
      "edit",
      "PRB-1",
      "--author",
      "interview",
      "--graph-edit",
      JSON.stringify({ op: "set_node_paths", id: "node_2", paths: ["packages/queue/**"] }),
    ]);
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    // Everything the hand edit pushed is behind us: what follows is the
    // interview's.
    const before = changes.length;
    await service.request({ kind: "interviewTurn", id, text: "please split the node" });
    const lines = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "tool"),
    );
    const card = lines.find((entry) => entry.line.kind === "tool")!.line;
    // The edit on the card is the one the store recorded, not the one the tool said it made.
    expect(card.kind === "tool" && card.edit).toMatchObject({
      n: 2,
      author: "interview",
      after: ["node:node_2"],
    });
    // And the records the Graph pane and the history draw are said to have
    // moved: the interview runs `perbo edit` inside its own process, so
    // nothing else says it.
    await waitFor(async () => {
      expect(
        changes
          .slice(before)
          .some(
            (change) =>
              change.kind === "records" && change.repoId === repoId && change.key === "PRB-1",
          ),
      ).toBe(true);
    });

    await finished(service, (await service.request({ kind: "graphUndo", repoId, key: "PRB-1", edit: 2 })).id);
    const after = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    // The hand edit survives: its node is still there, with the paths it gave it.
    expect(after.nodes.map((node) => node.title)).toContain("Queue one email");
    expect(after.nodes.find((node) => node.id === "node_1")?.paths).toEqual(["packages/auth/**"]);
    expect(after.nodes.find((node) => node.id === "node_2")?.paths).toEqual(twoCriteria.paths);
    expect(after.history[0]).toMatchObject({ n: 1, author: "you", undone: false });
    expect(after.history[1]).toMatchObject({ n: 2, author: "interview", undone: true });
    await service.request({ kind: "interviewStop", id });
  });

  it("cards the interview's own edit when a hand edit has landed since", async () => {
    const { service, repo, repoId, id } = await planning();
    const byHand = async (edit: Record<string, unknown>): Promise<void> => {
      await finished(
        service,
        (await service.request({ kind: "graphEdit", repoId, key: "PRB-1", edit: edit as never })).id,
      );
    };
    await byHand({
      op: "add_node",
      title: "Queue one email",
      criteria: ["ac_1"],
      new_criteria: [],
      paths: ["packages/auth/**"],
    });
    cli(repo, [
      "edit",
      "PRB-1",
      "--author",
      "interview",
      "--graph-edit",
      JSON.stringify({ op: "set_node_paths", id: "node_2", paths: ["packages/queue/**"] }),
    ]);
    // And a hand edit after the interview's, which is what the Graph pane does
    // while the interview is working: the record's last edit is not its own.
    await byHand({
      op: "set_node_paths",
      id: "node_1",
      paths: ["packages/auth/**", "packages/queue/**"],
    });

    const history = await service.request({ kind: "graphRead", repoId, key: "PRB-1" });
    expect(history.history.map((edit) => edit.author)).toEqual(["you", "interview", "you"]);

    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "please split the node" });
    const lines = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "tool"),
    );
    const card = lines.find((entry) => entry.line.kind === "tool")!.line;
    expect(card.kind === "tool" && card.edit).toMatchObject({
      n: 2,
      author: "interview",
      after: ["node:node_2"],
    });
    await service.request({ kind: "interviewStop", id });
  });

  it("starts the interview on the session this planning drafts with", async () => {
    const { service, repoId, id, fake } = await planning();
    const session = await service.request({ kind: "editingRead", id });
    await service.request({
      kind: "editingSave",
      id,
      revision: session.revision,
      repoId,
      form: { ...session.form, models: { ...session.form.models, draftingProvider: "codex-cli" } },
    });
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    const argv = JSON.parse(readFileSync(fake.argv, "utf8")) as string[];
    const at = argv.indexOf("--provider");
    expect(argv.slice(at, at + 2)).toEqual(["--provider", "codex"]);
    // And the id the session reports is recorded as that provider's, which is
    // what lets a later start continue it: recorded as the other's, the two
    // would never match and every start would open a new conversation.
    await spoken(service, id, (lines) =>
      lines.some((line) => line.line.kind === "note" && line.line.text.includes("The session is")),
    );
    const started = await service.request({ kind: "editingRead", id });
    expect(started.interviewProvider).toBe("codex");
    expect(interviewSessionArgs(started, "codex")).toEqual(["--session", "sdk-session-1"]);
    await service.request({ kind: "interviewStop", id });
  });
});

/**
 * SCP-320: the impact warnings for a planning session's draft (D-015, D-101).
 *
 * The index is the real `perbo index` over a real checkout, so what is under
 * test is the host: the inputs it derives from the registered repository and
 * the session's own records, the answer it hands the pane, and that asking for
 * it changes nothing.
 */
describe("the impact a draft reaches", () => {
  function monorepo() {
    const state = fixture();
    const { repo } = state;
    const write = (path: string, text: string): void => {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    write("packages/queue/src/retry.ts", "export const MAX_ATTEMPTS = 3;\n");
    write(
      "packages/auth/src/signup.ts",
      'import { MAX_ATTEMPTS } from "../../queue/src/retry.js";\n' +
        "export function signup(): number {\n  return MAX_ATTEMPTS;\n}\n",
    );
    write("packages/auth/package.json", JSON.stringify({ name: "@x/auth" }) + "\n");
    write("packages/auth/migrations/0001-users.sql", "CREATE TABLE users (id int);\n");
    write(
      "packages/web/src/checkout.ts",
      'import { signup } from "../../auth/src/signup.js";\nexport const go = signup;\n',
    );
    write("packages/web/src/session/cookie.ts", "export const NAME = \"sid\";\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "Stock the monorepo"], { cwd: repo, stdio: "ignore" });
    return state;
  }
  /** One planning session over `repoId`, with the scope this draft declares. */
  async function planning(
    service: DesktopService,
    repoId: string,
    paths: string[],
  ): Promise<string> {
    const opened = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    const saved = await service.request({
      kind: "editingSave",
      id: opened.id,
      revision: opened.revision,
      repoId,
      form: { ...opened.form, draft: { ...opened.form.draft, paths } },
    });
    expect(saved.form.draft.paths).toEqual(paths);
    return opened.id;
  }
  const warned = (view: { warnings: { path: string }[] }): string[] =>
    view.warnings.map((warning) => warning.path);
  const reasons = (view: { warnings: { path: string; reasons: { kind: string }[] }[] }, path: string): string[] =>
    view.warnings.find((warning) => warning.path === path)?.reasons.map((reason) => reason.kind) ?? [];

  it("names the importers outside the scope and the hazard classes the change reaches", async () => {
    const { service, repo } = monorepo();
    const registered = await service.registerRepository(repo);
    const id = await planning(service, registered.id, ["packages/auth/src/**"]);
    const view = await service.request({ kind: "impactRead", id });
    expect(view.index.read).toBe(true);
    expect(view.index.commit).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    );
    expect(view.index.note).toBeNull();
    expect(reasons(view, "packages/web/src/checkout.ts")).toEqual(["imports_scope"]);
    // A path carries every class that holds of it: `packages/auth/**` is
    // security-sensitive as well as a manifest and as well as a migration.
    expect(reasons(view, "packages/auth/package.json")).toEqual(["dependency", "security"]);
    expect(reasons(view, "packages/auth/migrations/0001-users.sql")).toEqual([
      "migration",
      "security",
    ]);
    // A different package the change does not reach, and the change itself.
    expect(warned(view)).not.toContain("packages/web/src/session/cookie.ts");
    expect(warned(view)).not.toContain("packages/auth/src/signup.ts");
    expect(view.scope).toEqual(["packages/auth/src/**"]);
  });

  it("is advice: asking for it writes nothing to the draft or the spec", async () => {
    const { service, repo } = monorepo();
    const registered = await service.registerRepository(repo);
    const id = await planning(service, registered.id, ["packages/auth/src/**"]);
    await saveSpec(service, {
      kind: "specSave",
      id,
      repoId: registered.id,
      title: "Signup retries",
      sections: {
        outcome: "Signup retries instead of failing.",
        requirements: "- A failed signup is retried.",
        no_gos: "- Changing the queue's own limits.",
        rabbit_holes: "",
        notes: "The importer is packages/web/src/checkout.ts.",
      },
    });
    const specPath = join(repo, "specs", "signup-retries", "spec.md");
    const before = {
      session: await service.request({ kind: "editingRead", id }),
      spec: readFileSync(specPath, "utf8"),
    };
    const view = await service.request({ kind: "impactRead", id });
    expect(view.warnings.length).toBeGreaterThan(0);
    // Asking still rebuilds the index file `perbo index` keeps, which is not
    // the draft or the spec: the two things this test's title promises nothing happens to.
    expect(existsSync(join(repo, ".perbo", "index.json"))).toBe(true);
    const after = {
      session: await service.request({ kind: "editingRead", id }),
      spec: readFileSync(specPath, "utf8"),
    };
    expect(after.spec).toBe(before.spec);
    expect(after.session.revision).toBe(before.session.revision);
    expect(after.session.form).toEqual(before.session.form);
    expect(after.session.history).toEqual(before.session.history);
    // Twice over: a second ask still adds nothing.
    await service.request({ kind: "impactRead", id });
    expect(readFileSync(specPath, "utf8")).toBe(before.spec);
    expect((await service.request({ kind: "editingRead", id })).revision).toBe(
      before.session.revision,
    );
  });

  it("reads a path the spec names where it lands, and never one that leaves the repository", async () => {
    const { service, repo } = monorepo();
    const registered = await service.registerRepository(repo);
    const id = await planning(service, registered.id, ["packages/auth/src/**"]);
    await saveSpec(service, {
      kind: "specSave",
      id,
      repoId: registered.id,
      title: "Signup retries",
      sections: {
        outcome: "Signup retries instead of failing.",
        requirements: "- A failed signup is retried.",
        no_gos: "",
        rabbit_holes: "",
        notes:
          "The limit is in packages/auth/../queue/src/retry.ts. " +
          "Not ../../etc/passwd, not /etc/passwd, not packages\\queue\\src\\retry.ts.",
      },
    });
    const view = await service.request({ kind: "impactRead", id });
    expect(view.named.paths).toEqual(["packages/queue/src/retry.ts"]);
    expect(reasons(view, "packages/queue/src/retry.ts")).toContain("named");
    expect(warned(view).some((path) => path.includes("passwd"))).toBe(false);
  });

  it("shows only the path classes for a repository the index cannot read, and says why", async () => {
    const { service, repo } = fixture();
    mkdirSync(join(repo, "app", "api"), { recursive: true });
    mkdirSync(join(repo, "app", "migrations"), { recursive: true });
    mkdirSync(join(repo, "app", "auth"), { recursive: true });
    writeFileSync(join(repo, "app", "api", "orders.py"), "def orders():\n    return []\n");
    writeFileSync(join(repo, "app", "migrations", "0001_init.sql"), "CREATE TABLE orders (id int);\n");
    writeFileSync(join(repo, "app", "auth", "session.py"), "SESSION = 'sid'\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "A repository outside TypeScript"], {
      cwd: repo,
      stdio: "ignore",
    });
    const registered = await service.registerRepository(repo);
    const id = await planning(service, registered.id, ["app/api/**"]);
    const view = await service.request({ kind: "impactRead", id });
    expect(view.index.read).toBe(false);
    expect(view.index.commit).toBeNull();
    expect(view.index.note).toContain("Nothing here reads imports");
    expect(view.index.note).toContain("Tracked extensions here: .md .py .sql");
    expect(warned(view)).toEqual(["app/auth/session.py", "app/migrations/0001_init.sql"]);
    expect(view.warnings.flatMap((warning) => warning.reasons.map((reason) => reason.kind))).toEqual([
      "security",
      "migration",
    ]);
    // No index file is written for a repository there is no index to build.
    expect(existsSync(join(repo, ".perbo", "index.json"))).toBe(false);
  });

  it("never names a path nothing here reads, and answers beside an exclusive command", async () => {
    const { service, repo } = monorepo();
    writeFileSync(join(repo, "packages", "auth", ".env"), "TOKEN=shhh\n");
    mkdirSync(join(repo, "packages", "auth", "secrets"), { recursive: true });
    writeFileSync(join(repo, "packages", "auth", "secrets", "key.txt"), "shhh\n");
    writeFileSync(join(repo, "packages", "auth", "AGENTS.md"), "# Agent rules\n");
    // A never-read file the index does read — `perbo index` has no never-read
    // filter of its own — inside the scope, imported from outside it. Without
    // the guard its path is read out by the importer's own sentence.
    mkdirSync(join(repo, "packages", "auth", "src", "secrets"), { recursive: true });
    writeFileSync(join(repo, "packages", "auth", "src", "secrets", "keys.ts"), "export const KEY = \"k\";\n");
    writeFileSync(
      join(repo, "packages", "web", "src", "billing.ts"),
      'import { KEY } from "../../auth/src/secrets/keys.js";\n' +
        'import { signup } from "../../auth/src/signup.js";\n' +
        "export const bill = [KEY, signup];\n",
    );
    execFileSync("git", ["add", "-A", "-f"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "Add what nothing reads"], { cwd: repo, stdio: "ignore" });
    const registered = await service.registerRepository(repo);
    const id = await planning(service, registered.id, ["packages/auth/src/**"]);
    const doctor = await service.request({
      kind: "doctor",
      repoId: registered.id,
      writeConfig: false,
    });
    try {
      const view = await service.request({ kind: "impactRead", id });
      for (const hidden of [
        "packages/auth/.env",
        "packages/auth/secrets/key.txt",
        "packages/auth/AGENTS.md",
      ])
        expect(warned(view), hidden).not.toContain(hidden);
      // The same call still warns, so the silence above is the never-read list.
      expect(warned(view)).toContain("packages/auth/package.json");
      // Nor inside the sentence beside a warning, which is the other way a path
      // reaches the screen. The importer is listed and names its one readable
      // import, so the silence is the guard and not an empty answer.
      expect(warned(view)).not.toContain("packages/auth/src/secrets/keys.ts");
      expect(
        view.warnings
          .find((warning) => warning.path === "packages/web/src/billing.ts")
          ?.reasons.find((reason) => reason.kind === "imports_scope")?.detail,
      ).toBe("imports packages/auth/src/signup.ts, which this draft changes");
      expect(JSON.stringify(view)).not.toContain("secrets");
    } finally {
      await finished(service, doctor.id);
    }
  });
});

function setTicketState(
  repo: string,
  key: string,
  state: string,
): { ticket_id: string } {
  const path = join(repo, ".perbo", "tickets", `${key}.json`);
  const ticket = JSON.parse(readFileSync(path, "utf8")) as {
    state: string;
    ticket_id: string;
  };
  ticket.state = state;
  writeFileSync(path, JSON.stringify(ticket, null, 2));
  return ticket;
}

describe("UI v2 host behaviour", () => {
  it("files already-finished tickets on the first listing, then archives and restores by hand as a preference", async () => {
    const { service, repo, options } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, outcome: "A second outcome" },
        })
      ).id,
    );
    setTicketState(repo, "PRB-1", "merged");
    // A profile that predates the preference: the first complete listing files what had already finished.
    const profile = join(options.dataDirectory, "workspace.json");
    const stored = JSON.parse(readFileSync(profile, "utf8")) as Record<
      string,
      unknown
    >;
    delete stored["archived"];
    delete stored["archivedSeeded"];
    writeFileSync(profile, JSON.stringify(stored));
    await service.shutdown();
    const restarted = trackService(new DesktopService(options));
    const snapshot = await restarted.snapshot();
    expect(snapshot.archived).toEqual([registered.id + ":PRB-1"]);
    expect(snapshot.tasks.map((row) => row.ticket.key).sort()).toEqual([
      "PRB-1",
      "PRB-2",
    ]);
    setTicketState(repo, "PRB-2", "merged");
    expect((await restarted.snapshot()).archived).toEqual([
      registered.id + ":PRB-1",
    ]);
    await restarted.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-2"],
      archived: true,
    });
    expect((await restarted.snapshot()).archived?.sort()).toEqual([
      registered.id + ":PRB-1",
      registered.id + ":PRB-2",
    ]);
    await restarted.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-1"],
      archived: false,
    });
    expect((await restarted.snapshot()).archived).toEqual([
      registered.id + ":PRB-2",
    ]);
    await expect(
      restarted.request({
        kind: "archive",
        repoId: registered.id,
        keys: ["PRB-9"],
        archived: true,
      }),
    ).rejects.toThrow(/not in the repository/);
    const ticket = JSON.parse(
      readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8"),
    ) as { state: string };
    expect(ticket.state).toBe("merged");
  });

  it("summarises a ticket from its retained attempts and reports the month's ledger with injected provider windows", async () => {
    const { service, repo } = fixture(async (binary, args, options) =>
      binary === "codex" || binary === "claude"
        ? {
            code: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }),
            stderr: "",
            cancelled: false,
          }
        : runProcess(binary, args, options),
    );
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    const empty = await service.request({
      kind: "taskSummary",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(empty).toEqual({
      branch: null,
      attempts: 0,
      latestAttemptAt: null,
      costMicros: null,
      costBasis: "none",
      diff: null,
      note: null,
    });
    const { ticket_id } = setTicketState(repo, "PRB-1", "merged");
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    const now = new Date();
    const month =
      now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    writeFileSync(
      join(repo, ".perbo", "state", `${ticket_id}.attempts.json`),
      JSON.stringify({
        ticket_id,
        attempts: [
          {
            attempt_id: "att_1",
            branch: "ayo/prb-1",
            created_at: `${month}-02T10:00:00.000Z`,
            usage: { cost_micros: 1_250_000, wall_clock_ms: 10 },
            // D-096: the stop a run has by default, and the one the ledger and
            // the notification both count.
            termination: { reason: "stalled" },
          },
          {
            attempt_id: "att_2",
            branch: "ayo/prb-1",
            created_at: `${month}-03T10:00:00.000Z`,
            usage: { cost_micros: 750_000, wall_clock_ms: 10 },
            termination: { reason: "completed" },
          },
        ],
      }),
    );
    const summary = await service.request({
      kind: "taskSummary",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(summary).toMatchObject({
      branch: "ayo/prb-1",
      attempts: 2,
      costMicros: 2_000_000,
      costBasis: "priced",
      diff: null,
    });
    const usage = await service.request({ kind: "usage" });
    expect(usage.ledger).toEqual({
      month,
      spentMicros: 2_000_000,
      pricedAttempts: 2,
      unpricedAttempts: 0,
      ticketsRun: 1,
      ticketsMerged: 1,
      stoppedShort: 1,
      averageMergedMicros: 2_000_000,
    });
    expect(
      usage.providers.find((provider) => provider.id === "codex"),
    ).toMatchObject({
      plan: "Pro",
      windows: [{ usedPercent: 23 }],
      detail: "Injected.",
    });
    expect(
      usage.providers.find((provider) => provider.id === "claude")?.windows,
    ).toBeNull();
    expect(
      usage.providers.find((provider) => provider.id === "claude")?.detail,
    ).toMatch(/without spending a turn/);
    await expect(
      service.request({
        kind: "taskSummary",
        repoId: registered.id,
        key: "PRB-7",
      }),
    ).rejects.toThrow(/no longer in the repository/);
  });

  it("notifies on the recorded moment a person asked for, silently unless sound is on, and holds sleep only while a run is live", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "approve")
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      if (args[1] === "run") {
        options.onOutput?.("  worktree /tmp/w on ayo/prb-1 at 123\n");
        options.onOutput?.(
          "  worktree /tmp/w on ayo/prb-1 at 123\n  executing\n",
        );
        await Promise.race([
          held,
          new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        ]);
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, notifications, holds, changes, themes, setBattery } =
      fixture(runner);
    expect(themes).toEqual(["system"]);
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    const settings = SettingsSchema.parse({
      ...(await service.snapshot()).settings,
      notifyOn: { decision: true, review: true, ceiling: true, stage: true },
      notifySound: false,
      afk: { holdSleep: true, displaySleep: false, releaseOnBattery: true },
      theme: "dark",
    });
    await service.request({ kind: "saveSettings", settings });
    expect(themes.at(-1)).toBe("dark");
    const detail = await service.detail(registered.id, "PRB-1");
    const job = await service.request({
      kind: "run",
      repoId: registered.id,
      key: "PRB-1",
      digest: detail.digest,
      approve: true,
      publish: false,
      resumeFrom: null,
    });
    await vi.waitFor(() =>
      expect(holds.at(-1)).toEqual({ hold: true, displaySleep: false }),
    );
    expect((await service.snapshot()).power).toMatchObject({
      holding: true,
      detail: expect.stringContaining("PRB-1"),
    });
    expect(
      changes.some((change) => change.kind === "power" && change.power.holding),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(notifications.map((entry) => entry.title)).toEqual([
        "PRB-1 · Materialising the worktree",
        "PRB-1 · Working on the approved outcome",
      ]),
    );
    expect(notifications[0]?.silent).toBe(true);
    setBattery(true);
    service.powerChanged();
    expect(holds.at(-1)).toEqual({ hold: false, displaySleep: false });
    expect((await service.snapshot()).power).toMatchObject({
      holding: false,
      detail: "Released on battery power.",
    });
    setBattery(false);
    service.powerChanged();
    expect(holds.at(-1)).toEqual({ hold: true, displaySleep: false });
    setTicketState(repo, "PRB-1", "changes_requested");
    release();
    await finished(service, job.id);
    await vi.waitFor(() =>
      expect(notifications.at(-1)).toEqual({
        title: "PRB-1 needs a decision",
        body: "The loop is paused until you answer.",
        silent: true,
      }),
    );
    expect(holds.at(-1)).toEqual({ hold: false, displaySleep: false });
    expect((await service.snapshot()).power).toEqual({
      holding: false,
      detail: null,
      since: null,
    });
  });

  it("opens the worktree on the branch a ticket already has, whatever its key would derive", async () => {
    const { service, repo, root, options } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    // The branch the ticket's pull request is on: `ayo/`, which PRB-1's key
    // does not derive.
    const path = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(path, "utf8")) as {
      ticket_id: string;
      delivery: { branch: string | null };
    };
    const recorded = `ayo/${ticket.ticket_id.replace(/^ticket_/, "")}/make-errors-actionable`;
    ticket.delivery.branch = recorded;
    writeFileSync(path, JSON.stringify(ticket, null, 2));
    const worktree = join(root, "worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", recorded, worktree], {
      cwd: repo,
      stdio: "ignore",
    });
    const opened: string[] = [];
    options.io.openPath = async (target) => {
      opened.push(target);
    };
    await service.request({
      kind: "openWorktree",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(opened).toEqual([realpathSync(worktree)]);
  });
});

describe("planning beside a run (SCP-335)", () => {
  /**
   * A process double over the real CLI: `run` and, once `holdAdmit` is set,
   * `admit` stay in flight until released or aborted. `reached` resolves when a
   * held `admit` is actually inside the CLI call, so a test can act on a
   * command that has started rather than one that is only registered.
   */
  function held() {
    const aborted: string[] = [];
    let releaseRun!: () => void, releaseAdmit!: () => void, reached!: () => void;
    const run = new Promise<void>((resolve) => { releaseRun = resolve; });
    const admit = new Promise<void>((resolve) => { releaseAdmit = resolve; });
    const inAdmit = new Promise<void>((resolve) => { reached = resolve; });
    let holdAdmit = false;
    let holdListAfterRun = false, runReturned = false, releaseList!: () => void, listReached!: () => void;
    const list = new Promise<void>((resolve) => { releaseList = resolve; });
    const inList = new Promise<void>((resolve) => { listReached = resolve; });
    const wait = async (
      until: Promise<void>,
      name: string,
      signal: AbortSignal | undefined,
    ): Promise<boolean> => {
      await Promise.race([
        until,
        new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (!signal?.aborted) return false;
      aborted.push(name);
      return true;
    };
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "approve")
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      if (args[1] === "run") {
        const stopped = await wait(run, "run", options.signal);
        runReturned = true;
        return { code: 0, stdout: "{}", stderr: "", cancelled: stopped };
      }
      // The receipt of a finished run reads the store; holding that read keeps
      // the finished job tracked, which is the window a stop must not reach it in.
      if (holdListAfterRun && runReturned && args[1] === "list") {
        holdListAfterRun = false;
        listReached();
        await list;
      }
      if (holdAdmit && args[1] === "admit") {
        reached();
        if (await wait(admit, "admit", options.signal))
          return { code: 130, stdout: "", stderr: "", cancelled: true };
      }
      return runProcess(binary, args, options);
    };
    return {
      runner,
      aborted,
      inAdmit,
      holdAdmit: () => { holdAdmit = true; },
      holdListAfterRun: () => { holdListAfterRun = true; },
      inList,
      release: () => { releaseRun(); releaseAdmit(); releaseList(); },
    };
  }
  async function runInFlight(service: DesktopService, repoId: string) {
    await finished(
      service,
      (await service.request({ kind: "admit", repoId, draft })).id,
    );
    const detail = await service.detail(repoId, "PRB-1");
    return service.request({
      kind: "run",
      repoId,
      key: "PRB-1",
      digest: detail.digest,
      approve: true,
      publish: false,
      resumeFrom: null,
    });
  }

  it("admits and edits beside a live run, and refuses another exclusive command by name", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);

    const admitted = await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, outcome: "A second outcome, planned beside it" },
        })
      ).id,
    );
    expect(admitted.state).toBe("completed");
    expect(admitted.resultKey).toBe("PRB-2");
    const second = await service.detail(registered.id, "PRB-2");
    const edited = await finished(
      service,
      (
        await service.request({
          kind: "edit",
          repoId: registered.id,
          key: "PRB-2",
          digest: second.digest,
          draft: { ...draft, outcome: "A second outcome, edited beside it" },
        })
      ).id,
    );
    expect(edited.state).toBe("completed");

    for (const request of [
      {
        kind: "run" as const,
        repoId: registered.id,
        key: "PRB-2",
        digest: second.digest,
        approve: true,
        publish: false,
        resumeFrom: null,
      },
      {
        kind: "decide" as const,
        repoId: registered.id,
        key: "PRB-1",
        digest: second.digest,
        answer: "Take the smaller change.",
      },
      { kind: "sync" as const, repoId: registered.id, key: "PRB-1" },
      { kind: "doctor" as const, repoId: registered.id, writeConfig: false },
      {
        kind: "principle" as const,
        repoId: registered.id,
        key: "PRB-1",
        answer: "Prefer the smaller change.",
      },
    ])
      await expect(service.request(request)).rejects.toThrow(
        "Run engineering loop is already running. Wait for it to finish or stop it before starting this one.",
      );

    expect(
      (await service.snapshot()).jobs.find((job) => job.id === run.id)?.state,
    ).toBe("running");
    holder.release();
    const ran = await finished(service, run.id);
    expect(ran.state).toBe("completed");
    expect(ran.error).toBeNull();
    expect(ran.key).toBe("PRB-1");
  });

  it("stops the job it is named and leaves the other lane running", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);
    holder.holdAdmit();
    const planning = await service.request({
      kind: "admit",
      repoId: registered.id,
      draft: { ...draft, outcome: "Planned while the loop runs" },
    });
    await holder.inAdmit;

    await service.request({ kind: "cancel", jobId: planning.id });
    expect((await finished(service, planning.id)).state).toBe("cancelled");
    expect(
      (await service.snapshot()).jobs.find((job) => job.id === run.id)?.state,
    ).toBe("running");

    await service.request({ kind: "cancel", jobId: run.id });
    expect((await finished(service, run.id)).state).toBe("cancelled");
    holder.release();
  });

  it("lands two drafts in flight on their own editing sessions", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const start = async (outcome: string) => {
      const opened = await service.request({
        kind: "editingOpen",
        target: { kind: "fresh", repoId: registered.id },
      });
      const saved = await service.request({
        kind: "editingSave",
        id: opened.id,
        revision: opened.revision,
        repoId: registered.id,
        form: { ...opened.form, draft: { ...draft, outcome }, step: 2 },
      });
      return {
        id: saved.id,
        revision: saved.revision,
        operationId: randomUUID(),
        outcome,
      };
    };
    const sessions = [
      await start("The first person's own outcome"),
      await start("The second person's own outcome"),
    ];
    const submitted = await Promise.all(
      sessions.map((session) =>
        service.request({
          kind: "editingSubmit",
          id: session.id,
          revision: session.revision,
          operationId: session.operationId,
          intent: "compile",
        }),
      ),
    );
    // Neither submission was refused: both are in flight at once.
    expect(submitted.map((session) => session.operation?.state)).toEqual([
      "running",
      "running",
    ]);
    await Promise.all(
      submitted.map((session) => finished(service, session.operation!.jobId!)),
    );
    const landed = await Promise.all(
      sessions.map((session) =>
        service.request({ kind: "editingRead", id: session.id }),
      ),
    );
    expect(landed.map((session) => session.operation?.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(
      landed.map((session) => session.operation?.resultKey).sort(),
    ).toEqual(["PRB-1", "PRB-2"]);
    for (const [index, session] of landed.entries()) {
      const own = sessions[index]!;
      expect(session.operation?.id).toBe(own.operationId);
      expect(session.key).toBe(session.operation?.resultKey);
      expect(session.form.draft.outcome).toBe(own.outcome);
      expect(
        (await service.detail(registered.id, session.key!)).contract.outcome,
      ).toBe(own.outcome);
    }
  });

  it("refuses to stop a job that has finished while its receipt is still being saved", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);
    holder.holdListAfterRun();
    holder.release();
    await holder.inList;
    // The run's process has returned and its job is finished, but its receipt
    // is still being written, so it is still tracked.
    await expect(service.request({ kind: "cancel", jobId: run.id })).rejects.toThrow(
      "That command is no longer active.",
    );
    holder.release();
    const settled = await finished(service, run.id);
    expect(settled.state).toBe("completed");
    // Nothing is left in the way: the lane is free once the receipt is saved.
    const snapshot = await service.snapshot();
    expect(snapshot.jobs.filter((job) => ["running", "stopping"].includes(job.state))).toEqual([]);
  });
});
