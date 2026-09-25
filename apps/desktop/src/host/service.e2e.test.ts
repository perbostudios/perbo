import { interviewSessionArgs, REREAD_COULD_NOT_START, untouchedPlanning } from "../shared/contract-editing.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopService, type ServiceOptions } from "./service.js";
import { runProcess, startLineProcess } from "./process.js";
import { EVERY_PROBLEM_RESOLVED, GRAPH_NODE_STATES, INTERVIEW_WROTE_THE_SPEC, SettingsSchema } from "../shared/protocol.js";
import { isLive, lane } from "../shared/jobs.js";
import { DELETE_WAITS_FOR_COMMANDS } from "../shared/discard.js";
import type {
  Change,
  Draft,
  InterviewEntry,
  Job,
  SpecSections,
  SpecView,
} from "../shared/protocol.js";
import { CriterionEvidenceBindingSchema } from "@perbo/contracts";
import type { GraphEdit } from "@perbo/contracts";
import { disposeFixtures, fixture, scratchDirectory, trackService } from "./test-support/host-fixture.js";
import { Profile } from "./profile/store.js";

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

  it("takes the spec folder with the planning that was writing it", async () => {
    // A piece of work is one thing and is deleted as one. Writing left behind
    // puts a row back in the picker under the same title the moment the delete
    // finishes, which reads as the delete having made a copy of the thing it
    // removed (D-129).
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "A light colour mode",
      sections,
    });
    const folder = join(repo, "specs", "a-light-colour-mode");
    expect(existsSync(folder)).toBe(true);

    await service.request({ kind: "editingDiscard", id: session.id });
    expect(existsSync(folder), "the writing goes with the planning").toBe(false);
    // And the picker has nothing left to offer for it.
    expect((await service.snapshot()).specs ?? []).toEqual([]);
  });

  /** A ticket in this repository, admitted the way the board admits one. */
  async function admitted(service: DesktopService, repoId: string): Promise<void> {
    const job = await service.request({
      kind: "admit",
      repoId,
      draft: {
        outcome: "New users receive an activation email",
        criteria: [{ text: "A signup queues one email", assertion: "signup.test.ts", kind: "test" }],
        paths: ["packages/auth/**"],
        prohibited: [],
      },
    });
    await finished(service, job.id);
  }

  /** That ticket's record, as a repository could carry it. */
  function recordSpecPath(repo: string, path: string): void {
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as {
      state: string;
      admission: { spec?: unknown };
    };
    ticket.state = "plan_review";
    ticket.admission.spec = {
      path,
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(at, JSON.stringify(ticket));
  }

  it("refuses a recorded spec path that climbs out of the spec folder", async () => {
    // The path reaches this from an admission record, which is a file in the
    // repository rather than anything this process wrote, and the delete it
    // feeds is recursive. `safePath` alone does not make it safe: it refuses a
    // path landing outside the repository, and `..` lands back inside it —
    // `specs/../..` is the repository root.
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "A light colour mode",
      sections,
    });
    await admitted(service, registered.id);
    recordSpecPath(repo, "specs/../../spec.md");

    // The delete itself succeeds — a climbing record is not a reason to refuse
    // to delete the contract, only a reason to touch no folder for it.
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    // The repository is still there, and so is every spec in it.
    expect(existsSync(join(repo, ".perbo")), "the repository").toBe(true);
    expect(existsSync(join(repo, "README.md")), "the working tree").toBe(true);
    expect(existsSync(join(repo, "specs", "a-light-colour-mode")), "an unrelated spec").toBe(true);
  });

  it("deletes no folder for a spec recorded under a folder this repository does not use", async () => {
    // The same reading, one step short of a climb: `docs/specs/foo/spec.md`
    // names a folder this repository is not keeping specs in, and `specs/foo`
    // is then an unrelated spec that happens to share the name.
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "A light colour mode",
      sections,
    });
    await admitted(service, registered.id);
    // The planning takes the ticket as it is opened, without claiming it made
    // it, and the record then names the other folder.
    recordSpecPath(repo, "specs/a-light-colour-mode/spec.md");
    const resumed = await service.request({
      kind: "editingOpen",
      target: { kind: "session", id: session.id },
    });
    expect(resumed.key).toBe("PRB-1");
    recordSpecPath(repo, "docs/specs/a-light-colour-mode/spec.md");
    const folder = join(repo, "specs", "a-light-colour-mode");

    // Thrown away, so no planning holds the folder and what keeps it is the
    // folder the records name: the ticket the planning holds names another.
    await service.request({ kind: "editingDiscard", id: session.id });
    expect(existsSync(folder), "the spec here, after the planning").toBe(true);
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    expect(existsSync(folder), "the spec here, after the ticket").toBe(true);
  });

  it("keeps the spec where the ticket naming it was not deleted", async () => {
    // A planning opened over a ticket the command line admitted did not make
    // it, so throwing the planning away leaves the ticket — and a plan is read
    // against the spec it names (D-103), so the spec stays with it. Deleting
    // the writing out from under a plan that survives is the one thing
    // `specDelete` refuses outright.
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "A light colour mode",
      sections,
    });
    await admitted(service, registered.id);
    recordSpecPath(repo, "specs/a-light-colour-mode/spec.md");
    // The session takes the ticket on open, as a planning resumed over one the
    // command line drafted does — without claiming it made it.
    const resumed = await service.request({
      kind: "editingOpen",
      target: { kind: "session", id: session.id },
    });
    expect(resumed.key, "the planning found the plan drafted from its spec").toBe("PRB-1");
    expect(resumed.admitted, "and does not claim to have made it").toBe(false);

    await service.request({ kind: "editingDiscard", id: session.id });
    const store = join(repo, ".perbo", "tickets");
    expect(existsSync(join(store, "PRB-1.json")), "work this planning did not do").toBe(true);
    expect(
      existsSync(join(repo, "specs", "a-light-colour-mode")),
      "the spec that plan is read against",
    ).toBe(true);
  });

  it("leaves a spec a planning is still writing when a ticket naming it is deleted", async () => {
    // That planning's work, and this delete was never asked about it.
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "A light colour mode",
      sections,
    });
    await admitted(service, registered.id);
    recordSpecPath(repo, "specs/a-light-colour-mode/spec.md");
    const folder = join(repo, "specs", "a-light-colour-mode");

    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    expect(existsSync(folder), "a planning is still writing it").toBe(true);

    // And once that planning goes too, so does the writing.
    await service.request({ kind: "editingDiscard", id: session.id });
    expect(existsSync(folder)).toBe(false);
  });

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

describe("each role's effort, beside its model", () => {
  it("keeps the default effort per role through the host and a restart", async () => {
    const { service, options } = fixture();
    const settings = SettingsSchema.parse({ executorEffort: "high", reviewerEffort: "low" });
    await service.request({ kind: "saveSettings", settings });
    expect((await service.snapshot()).settings).toMatchObject({ executorEffort: "high", reviewerEffort: "low" });
    await service.shutdown();
    const restarted = new DesktopService(options);
    trackService(restarted);
    expect((await restarted.snapshot()).settings).toMatchObject({ executorEffort: "high", reviewerEffort: "low" });
  });

  it("hands the run each role's effort as it hands it the model, the ticket's own choice first", async () => {
    let override: Record<string, unknown> | null = null;
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "run") {
        override = JSON.parse(readFileSync(args[args.indexOf("--config") + 1]!, "utf8")) as Record<string, unknown>;
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    await service.request({
      kind: "saveSettings",
      settings: SettingsSchema.parse({ executorEffort: "low", reviewerEffort: "low" }),
    });
    const run = async (): Promise<void> => {
      const detail = await service.detail(registered.id, "PRB-1");
      const ran = await finished(service, (await service.request({
        kind: "run", repoId: registered.id, key: "PRB-1", digest: detail.digest,
        approve: false, publish: false, resumeFrom: null,
      })).id);
      expect(ran.error).toBeNull();
    };
    await run();
    expect(override).toMatchObject({ model: "claude-opus-5", effort: "low", reviewer_model: "claude-opus-5", reviewer_effort: "low" });
    await service.request({
      kind: "taskModels",
      repoId: registered.id,
      key: "PRB-1",
      models: {
        executorProvider: "codex-cli",
        executorModel: "gpt-5.6-terra",
        executorEffort: "ultra",
        reviewerProvider: "claude-cli",
        reviewerModel: "claude-fable-5-1",
        reviewerEffort: "max",
        draftingProvider: "codex-cli",
        executorSkills: [],
      },
    });
    await run();
    expect(override).toMatchObject({
      agent_provider: "codex-cli",
      model: "gpt-5.6-terra",
      effort: "ultra",
      reviewer_provider: "claude-cli",
      reviewer_model: "claude-fable-5-1",
      reviewer_effort: "max",
    });
  });
});

describe("the pane a planning was left at (D-130)", () => {
  it("records the pane without moving the revision, and keeps it through a restart", async () => {
    const { service, repo, options } = fixture();
    const opened = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId: (await service.registerRepository(repo)).id } });
    expect(opened.lastPane).toBeNull();
    const visited = await service.request({ kind: "editingVisited", id: opened.id, pane: "explorer" });
    expect(visited.lastPane).toBe("explorer");
    // Not an edit: the revision a save was read at still holds, and a
    // planning only looked around in is still one nothing was put into.
    expect(visited.revision).toBe(opened.revision);
    expect(untouchedPlanning(visited)).toBe(true);
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === opened.id)?.lastPane).toBe("explorer");
    await service.shutdown();
    const restarted = new DesktopService(options);
    trackService(restarted);
    expect((await restarted.request({ kind: "editingRead", id: opened.id })).lastPane).toBe("explorer");
  });

  it("records the contract as the last pane with the state it was reached at, without moving the revision, through a restart", async () => {
    const { service, repo, options } = fixture();
    const opened = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId: (await service.registerRepository(repo)).id } });
    expect(opened.confirmed).toBeNull();
    await service.request({ kind: "editingVisited", id: opened.id, pane: "impact" });
    const atContract = await service.request({ kind: "editingContractVisited", id: opened.id, state: "0123456789abcdef" });
    expect(atContract).toMatchObject({ lastPane: "contract", confirmed: "0123456789abcdef", revision: opened.revision });
    expect(untouchedPlanning(atContract)).toBe(true);
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === opened.id)).toMatchObject({
      lastPane: "contract",
      confirmed: "0123456789abcdef",
    });
    await service.shutdown();
    const restarted = new DesktopService(options);
    trackService(restarted);
    expect((await restarted.request({ kind: "editingRead", id: opened.id })).lastPane).toBe("contract");
    // A pane reached after is the last place, and the state stays for the tab.
    const back = await restarted.request({ kind: "editingVisited", id: opened.id, pane: "impact" });
    expect(back).toMatchObject({ lastPane: "impact", confirmed: "0123456789abcdef" });
  });

  it("refuses a pane planning mode does not have, and the contract without the state it was reached at", async () => {
    const { service, repo } = fixture();
    const session = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId: (await service.registerRepository(repo)).id } });
    for (const pane of ["board", "contract"])
      await expect(
        service.request({ kind: "editingVisited", id: session.id, pane } as never),
      ).rejects.toThrow();
    expect((await service.request({ kind: "editingRead", id: session.id })).lastPane).toBeNull();
  });

  it("refuses to start with a record without one, naming the file and the field once", async () => {
    const { service, repo, options } = fixture();
    const repoId = (await service.registerRepository(repo)).id;
    const first = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    const second = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    await service.shutdown();
    const path = join(options.dataDirectory, "workspace.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { editingSessions: Record<string, unknown>[] };
    expect(stored.editingSessions.map((session) => session["id"]).sort()).toEqual([first.id, second.id].sort());
    for (const session of stored.editingSessions) delete session["lastPane"];
    writeFileSync(path, JSON.stringify(stored));
    let failure: unknown = null;
    try {
      trackService(new DesktopService(options));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(path);
    const message = (failure as Error).message;
    // One failure across both records is named once, with both indexes.
    expect(message).toContain("editingSessions[0,1].lastPane");
    expect(message.match(/lastPane/g)).toHaveLength(1);
    expect(message).toMatch(/correct the field or move the file aside\.$/i);
  });

  it("refuses to start with a record without the state its contract was reached at, naming the field", async () => {
    const { service, repo, options } = fixture();
    await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId: (await service.registerRepository(repo)).id } });
    await service.shutdown();
    const path = join(options.dataDirectory, "workspace.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { editingSessions: Record<string, unknown>[] };
    for (const session of stored.editingSessions) delete session["confirmed"];
    writeFileSync(path, JSON.stringify(stored));
    expect(() => trackService(new DesktopService(options))).toThrow(/editingSessions\[0\]\.confirmed/);
  });
});

describe("each repository's unsent ask (D-131)", () => {
  it("keeps each repository's text through a restart without a change event, and removes it on an empty text", async () => {
    const changes: { kind: string; asks?: Record<string, string> }[] = [];
    const { service, repo, options } = fixture(undefined, undefined, { changed: (change) => changes.push(change) });
    const repoId = (await service.registerRepository(repo)).id;
    expect((await service.snapshot()).asks).toEqual({});
    const before = changes.length;
    await service.request({ kind: "askSave", repoId, text: "Can you add a dark mode toggle" });
    expect((await service.snapshot()).asks).toEqual({ [repoId]: "Can you add a dark mode toggle" });
    // Sent at every pause in typing, it invalidates no read.
    expect(changes.slice(before)).toEqual([]);
    await service.shutdown();
    const restarted = new DesktopService(options);
    trackService(restarted);
    expect((await restarted.snapshot()).asks).toEqual({ [repoId]: "Can you add a dark mode toggle" });
    await restarted.request({ kind: "askSave", repoId, text: "" });
    expect((await restarted.snapshot()).asks).toEqual({});
    await restarted.shutdown();
    const again = new DesktopService(options);
    trackService(again);
    expect((await again.snapshot()).asks).toEqual({});
  });

  it("refuses a repository that is not connected, and forgets a repository's text with it", async () => {
    const { service, repo } = fixture();
    const repoId = (await service.registerRepository(repo)).id;
    await expect(service.request({ kind: "askSave", repoId: randomUUID(), text: "Anything" })).rejects.toThrow(
      /no longer connected/,
    );
    await service.request({ kind: "askSave", repoId, text: "Can you add a dark mode toggle" });
    await service.request({ kind: "forgetRepository", repoId });
    expect((await service.snapshot()).asks).toEqual({});
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
  async function graphed(runner?: typeof runProcess) {
    const made = fixture(runner);
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

  it("PRB-13: records each answer on its finding before the loop runs, and the graph reads them as decided", async () => {
    // The CLI's `verdict`, `principle` and `run` are stood in for and their
    // argv kept: a real `run` executes a coding agent, and what `verdict
    // --decide` writes and what the loop does with it are proven in the CLI's
    // and the runner's own tests (D-NEW-a-person-s-answer-closes-a-routed-finding).
    const calls: string[][] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (["verdict", "principle", "run"].includes(args[1] ?? "")) {
        calls.push(args.slice(1));
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, repoId, ticketId } = await graphed(runner);
    const digest = (await service.detail(repoId, "PRB-1")).digest;
    const lockfile = "7".repeat(64);
    const workflow = "8".repeat(64);
    const licence = "9".repeat(64);
    const routedToPerson = (key: string, statement: string) => ({
      key,
      rule_id: "repository.observation",
      criterion_id: "ac_2",
      severity: "major",
      status: "open",
      routing: "blocks",
      closure: "human",
      outcome: "unknown",
      statement,
    });
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
        createdAt: "2026-09-24T09:00:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          plan_version: 1,
          created_at: "2026-09-24T09:00:00.000Z",
          decision: "changes_requested",
          coverage: [binding("ac_2", "met", "packages/queue/retry.test.ts", 88)],
          findings: [
            routedToPerson(lockfile, "The repository carries two lockfiles."),
            routedToPerson(workflow, "No workflow runs the suite on a pull request."),
            routedToPerson(licence, "The repository states no licence."),
          ],
        }),
      },
    });
    const node = async () =>
      (await service.request({ kind: "graphRead", repoId, key: "PRB-1" })).live.nodes.find(
        (entry) => entry.id === "node_2",
      )!;
    expect((await node()).state).toBe("finding_open");

    const job = await finished(
      service,
      (
        await service.request({
          kind: "decide",
          repoId,
          key: "PRB-1",
          digest,
          answer: "For task PRB-1:\n1. package-lock.json is authoritative.\n\n2. CI is out of scope.",
          decisions: [
            { findingKey: lockfile, choice: "approach", answer: "package-lock.json is authoritative." },
            { findingKey: workflow, choice: "let_it_decide", answer: "CI is out of scope." },
            { findingKey: licence, choice: "ship_as_is", answer: "Ship it as it is." },
          ],
        })
      ).id,
    );
    expect(job.state).toBe("completed");
    const shown = { principle: 3, run: 6, verdict: 8 } as Record<string, number>;
    expect(calls.map((call) => call.slice(0, shown[call[0]!]))).toEqual([
      ["verdict", "PRB-1", "--decide", lockfile, "--choice", "approach", "--note", "package-lock.json is authoritative."],
      ["verdict", "PRB-1", "--decide", workflow, "--choice", "let-it-decide", "--note", "CI is out of scope."],
      ["verdict", "PRB-1", "--decide", licence, "--choice", "ship-as-is", "--note", "Ship it as it is."],
      ["principle", "add", "For task PRB-1:\n1. package-lock.json is authoritative.\n\n2. CI is out of scope."],
      ["run", "--ticket", "PRB-1", "--config", expect.any(String), "--json"],
    ]);
    for (const call of calls.slice(0, 3)) expect(call.slice(10, 12)).toEqual(["--replace", "--json"]);

    // What `perbo verdict --decide` leaves at the store's root, row for row.
    // Only the finding shipped as it is is closed by the answer itself; the
    // two handed to the executor are closed by the round's verification.
    const answered = (choices: Record<string, string>, reference = "PRB-1") =>
      writeFileSync(
        join(repo, ".perbo", "verdicts.json"),
        JSON.stringify({
          schema_version: 1,
          verdicts: Object.entries(choices).map(([finding_key, choice]) => ({
            review: { reference, ticket_id: ticketId, ticket_key: "PRB-1", pull_request_url: null },
            finding_key,
            rule_id: "repository.observation",
            routing: "blocks",
            decision: "decide",
            choice,
            author: "Owen",
            decided_at: "2026-09-24T09:30:00.000Z",
            note: "decided",
            superseded_at: null,
          })),
        }),
      );
    answered({ [lockfile]: "approach", [workflow]: "let_it_decide", [licence]: "ship_as_is" });
    expect((await node()).criteria.map((criterion) => criterion.finding)).toEqual([
      "The repository carries two lockfiles.",
    ]);
    const shipped = { [lockfile]: "ship_as_is", [workflow]: "ship_as_is", [licence]: "ship_as_is" };
    // Answers that name another review by its id answer that review alone.
    answered(shipped, "rev_two");
    expect((await node()).state).toBe("finding_open");
    answered(shipped, "rev_one");
    const decided = await node();
    expect(decided.state).not.toBe("finding_open");
    expect(decided.criteria.every((criterion) => criterion.finding === null)).toBe(true);
  });

  it("records none of a person's answers where one of them is not one the loop acts on", async () => {
    const calls: string[][] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (["verdict", "principle", "run"].includes(args[1] ?? "")) {
        calls.push(args.slice(1));
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, repoId, ticketId } = await graphed(runner);
    const digest = (await service.detail(repoId, "PRB-1")).digest;
    const [product, secret, remediable] = ["4", "5", "6"].map((digit) => digit.repeat(64)) as [string, string, string];
    const routed = (key: string, rule_id: string, routing: string) => ({
      key,
      rule_id,
      criterion_id: "ac_2",
      status: "open",
      routing,
      closure: "human",
      statement: `${rule_id} stands.`,
    });
    record(repo, ticketId, {
      attemptId: "att_0000000000000002",
      artifacts: [],
      review: {
        createdAt: "2026-09-24T09:00:00.000Z",
        body: JSON.stringify({
          review_id: "rev_one",
          decision: "escalate",
          findings: [
            routed(product, "product.preference", "escalates"),
            routed(secret, "security.secret_in_diff", "blocks"),
            routed(remediable, "test.missing_for_criterion", "remediable"),
          ],
        }),
      },
    });
    const decide = async (decisions: { findingKey: string; choice: "approach" | "ship_as_is"; answer: string }[]) =>
      finished(
        service,
        (await service.request({ kind: "decide", repoId, key: "PRB-1", digest, answer: "Answers.", decisions })).id,
      );
    const handedSecret = await decide([
      { findingKey: product, choice: "approach", answer: "Round half-even." },
      { findingKey: secret, choice: "approach", answer: "Rotate it." },
    ]);
    expect(handedSecret.state).toBe("failed");
    expect(handedSecret.error).toContain("its only answer is Ship as it is");
    const notRouted = await decide([
      { findingKey: product, choice: "approach", answer: "Round half-even." },
      { findingKey: remediable, choice: "ship_as_is", answer: "Ship it." },
    ]);
    expect(notRouted.state).toBe("failed");
    expect(notRouted.error).toContain("not one the review routed to you");
    expect(calls).toEqual([]);

    expect(
      (
        await decide([
          { findingKey: product, choice: "approach", answer: "Round half-even." },
          { findingKey: secret, choice: "ship_as_is", answer: "Ship it." },
        ])
      ).state,
    ).toBe("completed");
    expect(calls.map((call) => call[0])).toEqual(["verdict", "verdict", "principle", "run"]);

    // The same findings on a review that did not judge the whole change take
    // no answer at all: it would settle a finding on a change nobody finished judging.
    const review = (decision: string) =>
      record(repo, ticketId, {
        attemptId: "att_0000000000000002",
        artifacts: [],
        review: {
          createdAt: "2026-09-24T10:00:00.000Z",
          body: JSON.stringify({ review_id: "rev_one", decision, findings: [routed(product, "product.preference", "escalates")] }),
        },
      });
    for (const decision of ["incomplete", "error"]) {
      review(decision);
      const unjudged = await decide([{ findingKey: product, choice: "ship_as_is", answer: "Ship it." }]);
      expect(unjudged.state, decision).toBe("failed");
      expect(unjudged.error).toContain(`The review ended ${decision}: it did not judge the whole change`);
    }
    expect(calls).toHaveLength(4);
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
  /** Run PRB-1 from the digest it has now, and wait for the job to settle. */
  const runTicket = async (service: DesktopService, repoId: string, publish: boolean, approve: boolean): Promise<Job> =>
    finished(
      service,
      (
        await service.request({
          kind: "run",
          repoId,
          key: "PRB-1",
          digest: (await service.detail(repoId, "PRB-1")).digest,
          approve,
          publish,
          resumeFrom: null,
        })
      ).id,
    );
  it("records a run's publication choice on its job, and keeps it across a restart", async () => {
    // The CLI's own `run`, `principle` and `verdict` are stood in for, and
    // each run's configuration kept; approving is real.
    const published: boolean[] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "run")
        published.push(
          (JSON.parse(readFileSync(args[args.indexOf("--config") + 1]!, "utf8")) as { publish: boolean }).publish,
        );
      return args[1] === "run" || args[1] === "principle" || args[1] === "verdict"
        ? { code: 0, stdout: "{}", stderr: "", cancelled: false }
        : runProcess(binary, args, options);
    };
    const { service, repo, options } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    // The job as it is first announced, copied then: a stop can be taken from
    // that moment, before the operation behind it has started.
    const announced = new Map<string, Job>();
    options.changed = (change) => {
      if (change.kind === "progress" && !announced.has(change.job.id))
        announced.set(change.job.id, { ...change.job });
    };
    // The review the loop reads, routing the one finding each decision answers to a person.
    const body = Buffer.from(
      JSON.stringify({
        findings: [
          { key: "a".repeat(64), rule_id: "product.retry", status: "open", routing: "escalates", statement: "Keep the retry button?" },
        ],
        decision: "escalate",
      }),
    );
    const sha256 = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(repo, ".perbo", "bundles", "objects"), { recursive: true });
    mkdirSync(join(repo, ".perbo", "bundles", "bundles"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "bundles", "objects", sha256), body);
    writeFileSync(
      join(repo, ".perbo", "bundles", "bundles", "bundle_00000000000000ab.json"),
      JSON.stringify({
        bundle_id: "bundle_00000000000000ab",
        kind: "review",
        created_at: "2026-09-10T10:00:00.000Z",
        subject_id: "rev_one",
        ticket_id: (await service.detail(registered.id, "PRB-1")).ticket.ticket_id,
        artifacts: [{ name: "review.json", sha256, bytes: body.length, retained: true }],
      }),
    );
    const decide = async (
      decisions = [{ findingKey: "a".repeat(64), choice: "approach" as const, answer: "Keep the retry button" }],
    ): Promise<Job> =>
      finished(
        service,
        (
          await service.request({
            kind: "decide",
            repoId: registered.id,
            key: "PRB-1",
            answer: "Keep the retry button",
            decisions,
            digest: (await service.detail(registered.id, "PRB-1")).digest,
          })
        ).id,
      );
    const publishing = await runTicket(service, registered.id, true, true);
    const unpublished = await runTicket(service, registered.id, false, false);
    // A decision that answers findings carries on the run that stopped for
    // it, and publishes as it was going to; a principle alone publishes nothing.
    const decidedLocally = await decide();
    const republished = await runTicket(service, registered.id, true, false);
    const decidedPublishing = await decide();
    const principled = await decide([]);
    const jobs = [publishing, unpublished, decidedLocally, republished, decidedPublishing, principled];
    const choices = [true, false, false, true, true, false];
    expect(jobs.map((job) => [job.state, job.publish])).toEqual(choices.map((choice) => ["completed", choice]));
    expect(published).toEqual(choices);
    expect(jobs.map((job) => announced.get(job.id)?.publish)).toEqual(choices);
    await service.shutdown();
    const restarted = new DesktopService(options);
    trackService(restarted);
    const kept = (await restarted.snapshot()).jobs;
    expect(jobs.map((job) => kept.find((entry) => entry.id === job.id)?.publish)).toEqual(choices);
  });
  it("keeps a ticket's last run in the job journal after forty later jobs, so its stopped page still opens", async () => {
    // The loop stops short and `doctor` is the cheapest job there is: both stood in for.
    const runner: typeof runProcess = async (binary, args, options) =>
      args[1] === "run"
        ? { code: 1, stdout: "", stderr: "The executor stopped", cancelled: false }
        : args[1] === "doctor"
          ? { code: 0, stdout: "{}", stderr: "", cancelled: false }
          : runProcess(binary, args, options);
    const { service, repo } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const earlier = await runTicket(service, registered.id, true, true);
    const last = await runTicket(service, registered.id, true, true);
    expect(last.state).toBe("failed");
    const doctors: Job[] = [];
    for (let count = 0; count < 41; count++) {
      const job = await service.request({ kind: "doctor", repoId: registered.id, writeConfig: false });
      await vi.waitFor(() => expect(job.state).toBe("completed"), { interval: 5 });
      doctors.push(job);
    }
    const ids = (await service.snapshot()).jobs.map((job) => job.id);
    expect(ids).toContain(last.id);
    expect(ids).not.toContain(earlier.id);
    expect(ids).not.toContain(doctors[0]!.id);
    expect(ids).toEqual(expect.arrayContaining(doctors.slice(1).map((job) => job.id)));
    expect(ids).toHaveLength(41);
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

  // Approval freezes the scope, and the freeze is the CLI's: `perbo edit`
  // refuses every state but plan_review. Nothing on the mark path asks it, so
  // without this guard a mark on an approved ticket would be taken, written to
  // the draft, and never compiled in — a mark the person goes on believing in.
  // The standing list is the exception, because it is the repository's rather
  // than this ticket's and the write guard reads it again when a run starts
  // (D-105); it is the exception in both directions, or a path could be put on
  // it from an approved ticket and never taken off.
  it("freezes an approved ticket's own scope, and leaves the repository's list writable", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const opened = await service.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: registered.id, key: "PRB-1" },
    });
    // Approved on disk, which is what the guard reads, rather than by running
    // the loop for it.
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
    writeFileSync(at, JSON.stringify({ ...ticket, approved_at: new Date().toISOString() }));

    const mark = (always: boolean | null) =>
      service.request({
        kind: "explorerMark",
        id: opened.id,
        revision: opened.revision,
        path: "src/generated/",
        mark: "prohibited",
        always,
      });
    // This ticket's own scope: refused, and the reason says what to do.
    await expect(mark(null)).rejects.toThrow(/approved, so its scope is frozen/);
    // The repository's list: taken, onto it and back off it.
    const added = await mark(true);
    expect(added.form.draft.prohibited).toContain("src/generated/**");
    const removed = await service.request({
      kind: "explorerMark",
      id: opened.id,
      revision: added.revision,
      path: "src/generated/",
      mark: null,
      always: false,
    });
    expect(removed.form.draft.prohibited).not.toContain("src/generated/**");
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
// The spec folder a turn still in flight writes as the session winds down,
// where one is, and whether that write waits for the folder to be deleted: a
// session whose stdin has closed finishes the turn it is in.
let windsDown = null;
// Whether the turn in flight puts a group of questions as it winds down, after
// its stdin has closed and before it exits.
let asksAsItWindsDown = false;
send({ type: 'started', session_id: 'sdk-session-1', spec: 'specs/activation-email/spec.md',
  adr: 'docs/adr', model: null, tools: ['edit_plan', 'undo_edit', 'read_plan', 'ask_options'] });
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
    // A turn that moves the plan and the spec together, which is what the chat
    // has to say out loud: the spec is on another pane.
    if (turn.text.includes('change both')) {
      const argv = process.argv.slice(2);
      // --spec names the folder; the file under it is what the pane reads.
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\nAnd the button says so.\n');
      send({ type: 'tool', tool: 'edit_plan', ok: true, detail: 'PRB-1: edit 3 — tightened' });
    }
    // The interview writing the spec: said as the write is admitted, and then
    // made, which is what leaves the turn with a drafted spec and no plan.
    if (turn.text.includes('write the spec')) {
      const argv = process.argv.slice(2);
      send({ type: 'wrote_spec' });
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\nAnd the spec says so.\n');
    }
    // The interview titling the spec: its title line rewritten, as the
    // Architect writes the title it names the work by (D-118, D-127).
    if (turn.text.includes('title the spec')) {
      const argv = process.argv.slice(2);
      const file = argv[argv.indexOf('--spec') + 1] + '/spec.md';
      send({ type: 'wrote_spec' });
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^# .*$/m, '# Activation email on signup'));
    }
    // A turn that writes the file and then edits it again: two admitted
    // writes, which the session is entitled to make and which are one piece of
    // news to whoever is watching the chat.
    if (turn.text.includes('write it twice')) {
      const argv = process.argv.slice(2);
      const file = argv[argv.indexOf('--spec') + 1] + '/spec.md';
      send({ type: 'wrote_spec' });
      fs.appendFileSync(file, '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      fs.appendFileSync(file, '\nAnd says it again.\n');
    }
    // A turn that titles the spec and then never ends: the title is there
    // to be read while the turn is still going.
    if (turn.text.includes('title and hang')) {
      const argv = process.argv.slice(2);
      const file = argv[argv.indexOf('--spec') + 1] + '/spec.md';
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^# .*$/m, '# Activation email on signup'));
      send({ type: 'wrote_spec' });
      return;
    }
    // A turn that writes the spec and then never ends, for the person who
    // stops waiting: the file is written before the write is announced, so a
    // test that has seen the note knows the bytes are there.
    if (turn.text.includes('write and hang')) {
      const argv = process.argv.slice(2);
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      return;
    }
    // A turn that writes the spec and never ends until stdin closes, and then
    // writes it once more before it exits, a while after the stop: the Claude
    // session finishes the turn it is in after its stdin has closed. The
    // second write comes 200 ms after the close, or, for 'write back after a
    // delete', as soon as the folder has gone, or 2.5 s after the close where
    // it has not: inside the host's grace before it signals.
    if (turn.text.includes('write as it winds down') || turn.text.includes('write back after a delete')) {
      const argv = process.argv.slice(2);
      windsDown = { folder: argv[argv.indexOf('--spec') + 1],
        waitsForTheDelete: turn.text.includes('write back after a delete') };
      fs.appendFileSync(windsDown.folder + '/spec.md', '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      return;
    }
    // A turn that writes the spec and never ends until stdin closes, and then
    // puts a group of questions before it exits.
    if (turn.text.includes('ask as it winds down')) {
      const argv = process.argv.slice(2);
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      asksAsItWindsDown = true;
      return;
    }
    // A turn that writes the spec and then, a while after it is handed over,
    // says a closing line of its own before it ends.
    if (turn.text.includes('write then talk')) {
      const argv = process.argv.slice(2);
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      setTimeout(() => {
        send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The spec is written: read the Requirements first.' }] } } });
        send({ type: 'idle', turns: 1 });
      }, 300);
      return;
    }
    // A turn that writes the spec and says a closing line inside the moment
    // before the reading that hands it over, then ends once that has passed.
    // With the same bytes put back, there is no note for the line to wait on.
    if (turn.text.includes('write then close') || turn.text.includes('rewrite then close')) {
      const argv = process.argv.slice(2);
      const file = argv[argv.indexOf('--spec') + 1] + '/spec.md';
      if (turn.text.includes('rewrite')) fs.writeFileSync(file, fs.readFileSync(file));
      else fs.appendFileSync(file, '\nAnd the spec says so.\n');
      send({ type: 'wrote_spec' });
      setTimeout(() => {
        send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'That is the spec as I have it.' }] } } });
      }, 100);
      setTimeout(() => send({ type: 'idle', turns: 1 }), 700);
      return;
    }
    // A turn that writes somewhere the session is allowed to write that is
    // not the spec: no write is admitted against the spec, so nothing is
    // announced and the spec is where it was.
    if (turn.text.includes('write elsewhere')) {
      const argv = process.argv.slice(2);
      fs.appendFileSync(argv[argv.indexOf('--repo') + 1] + '/CONTEXT.md', '\nNotes.\n');
    }
    // And one whose admitted write puts the same text back: the event is the
    // call being allowed, so it is said, and the file did not move.
    if (turn.text.includes('rewrite the same spec')) {
      const argv = process.argv.slice(2);
      const file = argv[argv.indexOf('--spec') + 1] + '/spec.md';
      send({ type: 'wrote_spec' });
      fs.writeFileSync(file, fs.readFileSync(file));
    }
    // A group of questions put to the person and left standing, which is what
    // holds the way on to the plan.
    if (turn.text.includes('ask me'))
      send({ type: 'asked', groups: [{ title: 'Which way', parts: [{ question: 'Which way?',
        options: [{ label: 'This way', detail: null, recommended: true },
                  { label: 'That way', detail: null, recommended: false }] }] }] });
    // And one that moves only the plan, which says nothing extra.
    if (turn.text.includes('plan only'))
      send({ type: 'tool', tool: 'edit_plan', ok: true, detail: 'PRB-1: edit 4 — tightened' });
    // And one that really moves the plan, through the CLI's own edit path as
    // the interview's edit_plan tool does, so the change lands in the records
    // the host reads.
    if (turn.text.includes('reword the plan')) {
      const argv = process.argv.slice(2);
      require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(resolve("../cli/dist/perbo.js"))},
        'edit', 'PRB-1', '--author', 'interview', '--graph-edit',
        JSON.stringify({ op: 'set_criterion', id: 'ac_1', text: 'A signup queues exactly one email',
          expected_verification: { kind: 'test', assertion: 'signup.test.ts' } }),
        '--repo', argv[argv.indexOf('--repo') + 1]], { stdio: 'ignore' });
      send({ type: 'tool', tool: 'edit_plan', ok: true, detail: 'PRB-1: edit — reworded ac_1' });
    }
    // And one that writes more into a section than the record of a change
    // holds, so the marking of the turn is refused where the turn was not.
    if (turn.text.includes('write a long section')) {
      const argv = process.argv.slice(2);
      fs.appendFileSync(argv[argv.indexOf('--spec') + 1] + '/spec.md', '\n' + 'x'.repeat(13000) + '\n');
    }
    if (turn.text.includes('think out loud')) {
      send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
        message: { role: 'assistant', content: [{ type: 'text', text: "I'll look at what's here first." }] } } });
      send({ type: 'tool', tool: 'read_plan', ok: true, detail: 'PRB-1: two nodes' });
      // The middle of a turn: something worth reading, and more work after it.
      send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Node 2 is the cutover.' }] } } });
      send({ type: 'tool', tool: 'read_plan', ok: true, detail: 'PRB-1: and its criteria' });
    }
    send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You said: ' + turn.text }] } } });
    // Every turn ends, which is what stops the dock saying the session is
    // working — and what tells a line held through the turn that it was the
    // whole of it.
    send({ type: 'idle', turns: 1 });
  })
  .on('close', () => {
    const ended = () => send({ type: 'ended', session_id: 'sdk-session-1', reason: 'the session ended' });
    if (asksAsItWindsDown) {
      send({ type: 'asked', groups: [{ title: 'Which way', parts: [{ question: 'Which way?',
        options: [{ label: 'This way', detail: null, recommended: true },
                  { label: 'That way', detail: null, recommended: false }] }] }] });
      return ended();
    }
    if (windsDown === null) return ended();
    const { folder, waitsForTheDelete } = windsDown;
    const write = () => {
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(folder + '/spec.md', '\nWritten as the turn wound down.\n');
      ended();
    };
    if (!waitsForTheDelete) return void setTimeout(write, 200);
    const closedAt = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(folder) && Date.now() - closedAt < 2500) return;
      clearInterval(poll);
      write();
    }, 10);
  });
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
    const root = scratchDirectory("perbo-interview-");
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

  /**
   * One planning with a spec and no plan, and a fake interview in place of the
   * CLI's: the state the interview writes the spec in, before anybody has
   * pressed Generate plan (D-102).
   */
  async function writing(
    runs?: typeof runProcess,
    also?: Partial<ServiceOptions>,
  ): Promise<{
    service: DesktopService;
    repo: string;
    repoId: string;
    id: string;
    changes: Change[];
  }> {
    const root = scratchDirectory("perbo-interview-");
    const fake = fakeInterview(root);
    const spawns: typeof startLineProcess = (binary, args, options) =>
      startLineProcess(
        binary,
        args[1] === "interview" ? [fake.binary, ...args.slice(1)] : [...args],
        options,
      );
    const made = fixture(runs, spawns, also);
    const changes: Change[] = [];
    made.options.changed = (change) => changes.push(change);
    const registered = await made.service.registerRepository(made.repo);
    const session = await made.service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(made.service, {
      kind: "specSave",
      id: session.id,
      repoId: registered.id,
      title: "Activation email",
      sections: SECTIONS,
    });
    return { service: made.service, repo: made.repo, repoId: registered.id, id: session.id, changes };
  }

  /** What the status line said a planning's turns were doing, in the order it said it. */
  const doings = (changes: Change[], id: string): (string | null)[] =>
    changes.flatMap((change) =>
      change.kind === "interview" && change.sessionId === id ? [change.doing] : [],
    );

  /** Wait until the host has said the spec is being written. */
  async function writingSaid(changes: Change[], id: string): Promise<void> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if (doings(changes, id).includes("writing_the_spec")) return;
      await delay(10);
    }
    throw new Error("The host never said the spec was being written");
  }

  /** The interview, once its own `started` event has reached the record. */
  async function running(service: DesktopService, id: string): Promise<void> {
    for (let count = 0; count < 400; count++) {
      if ((await service.request({ kind: "editingRead", id })).interviewSession !== null) return;
      await delay(10);
    }
    throw new Error("The interview never reported a session");
  }

  /** The session, once the turn it owes the person is over. */
  async function settled(service: DesktopService, id: string): Promise<void> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if (!((await service.snapshot()).working ?? []).includes(id)) return;
      await delay(10);
    }
    throw new Error("The interview never finished its turn");
  }

  /** The conversation, once it says what the test is waiting for. */
  async function spoken(
    service: DesktopService,
    id: string,
    holds: (lines: InterviewEntry[]) => boolean,
  ): Promise<InterviewEntry[]> {
    // A deadline rather than a count of polls: a poll costs a round trip to the
    // service, and under a full run those are slow enough that four hundred of
    // them is a much shorter wait than it looks. A child process has to start,
    // read a turn and answer it, and that is what is being waited for.
    const until = Date.now() + 20_000;
    let lines: InterviewEntry[] = [];
    while (Date.now() < until) {
      lines = (await service.request({ kind: "editingRead", id })).conversation;
      if (holds(lines)) return lines;
      await delay(10);
    }
    // What it did say, so a failure names the shape it reached rather than only
    // the shape it wanted.
    throw new Error(
      `The interview never said what the test was waiting for. It said: ${
        lines.map((entry) => entry.line.kind).join(", ") || "nothing"
      }`,
    );
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
    const { service, repo, repoId, fake } = await planning();
    const fresh = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    expect(fresh.specSlug).toBeNull();

    await service.request({ kind: "interviewTurn", id: fresh.id, text: "Can you add a dark mode toggle" });
    await running(service, fresh.id);

    // The person's own words named the folder, and the argv is still derived
    // from the recorded slug rather than from anything a renderer sent.
    expect((await service.request({ kind: "editingRead", id: fresh.id })).specSlug).toBe(
      "dark-mode-toggle",
    );
    const argv = JSON.parse(readFileSync(fake.argv, "utf8")) as string[];
    expect(argv.slice(argv.indexOf("--spec"), argv.indexOf("--spec") + 2)).toEqual([
      "--spec",
      "specs/dark-mode-toggle",
    ]);
    // The cut is on the file's title line and recorded as the cut, so the
    // planning is listed with no title until another is written (D-118).
    expect((await service.request({ kind: "editingRead", id: fresh.id })).specCut).toBe("Dark mode toggle");
    expect(readFileSync(join(repo, "specs", "dark-mode-toggle", "spec.md"), "utf8").split("\n")[0]).toBe("# Dark mode toggle");
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === fresh.id)?.title).toBeNull();
    // The naming is said, and the turn it came from is part of the conversation.
    const lines = await spoken(service, fresh.id, (entries) =>
      entries.some(
        (entry) => entry.line.kind === "note" && entry.line.text.includes("from your first message"),
      ),
    );
    expect(kinds(lines)).toContain("turn");
    await service.request({ kind: "interviewStop", id: fresh.id });
  });

  describe("the chat's model (D-102)", () => {
    const offering = (ids: string[]): NonNullable<ServiceOptions["modelCatalog"]> => async (provider) => ({
      provider,
      source: "sample",
      discoveredAt: new Date().toISOString(),
      models: ids.map((id) => ({ id, label: id, description: "", isDefault: false, efforts: [] })),
    });
    const startedOn = async (service: DesktopService, repoId: string, id: string, argv: string): Promise<string> => {
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      const args = JSON.parse(readFileSync(argv, "utf8")) as string[];
      await service.request({ kind: "interviewStop", id });
      return args[args.indexOf("--model") + 1]!;
    };

    it("is Opus 5.5 where Claude Code's catalog lists it, and the record names it", async () => {
      const { service, repoId, id, fake, options } = await planning();
      options.modelCatalog = offering(["claude-opus-5[1m]", "claude-opus-5-5", "claude-sonnet-5"]);
      expect(await startedOn(service, repoId, id, fake.argv)).toBe("claude-opus-5-5");
      expect((await service.request({ kind: "editingRead", id })).interviewModel).toBe("claude-opus-5-5");
    });

    it("is the planning's own model where the catalog does not list Opus 5.5 or cannot be read", async () => {
      const { service, repoId, id, fake, options } = await planning();
      options.modelCatalog = async () => {
        throw new Error("Provider CLI unavailable.");
      };
      expect(await startedOn(service, repoId, id, fake.argv)).toBe("claude-opus-5");
      // Nothing was kept from a catalog that failed, so the next start reads it again.
      options.modelCatalog = offering(["claude-sonnet-5"]);
      expect(await startedOn(service, repoId, id, fake.argv)).toBe("claude-opus-5");
    });

    it("is read from the catalog the pickers last read, rather than asked for again", async () => {
      const { service, repoId, id, fake, options } = await planning();
      options.modelCatalog = offering(["claude-opus-5-5"]);
      await service.request({ kind: "models", provider: "claude-cli" });
      const asked = vi.fn(offering([]));
      options.modelCatalog = asked;
      expect(await startedOn(service, repoId, id, fake.argv)).toBe("claude-opus-5-5");
      expect(asked).not.toHaveBeenCalled();
    });

    it("keeps the planning's own model where it drafts on Codex, and reads no catalog", async () => {
      const { service, repoId, id, fake, options } = await planning();
      const session = await service.request({ kind: "editingRead", id });
      await service.request({
        kind: "editingSave",
        id,
        revision: session.revision,
        repoId,
        form: {
          ...session.form,
          models: { ...session.form.models, draftingProvider: "codex-cli", executorProvider: "codex-cli", executorModel: "gpt-5.6-terra" },
        },
      });
      const asked = vi.fn(offering(["claude-opus-5-5"]));
      options.modelCatalog = asked;
      expect(await startedOn(service, repoId, id, fake.argv)).toBe("gpt-5.6-terra");
      expect(asked).not.toHaveBeenCalled();
    });
  });

  describe("a planning with no plan is never read against its spec", () => {
    it("starts no reading and says no refusal as the first turn on a fresh planning ends", async () => {
      const { service, repoId } = await planning();
      const fresh = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
      await service.request({ kind: "interviewTurn", id: fresh.id, text: "Can you add a dark mode toggle" });
      await spoken(service, fresh.id, (entries) =>
        entries.some((entry) => entry.line.kind === "said" && entry.line.text.startsWith("You said:")),
      );
      await settled(service, fresh.id);
      // Past the turn's end and whatever it started: a reading refused before
      // its job began says so a few round trips after the idle.
      for (let round = 0; round < 20; round++) await service.snapshot();
      await delay(100);
      const session = await service.request({ kind: "editingRead", id: fresh.id });
      expect(session.key).toBeNull();
      expect((await service.snapshot()).jobs.filter((job) => job.kind === "drift")).toEqual([]);
      expect(
        session.conversation.filter(
          (entry) => entry.line.kind === "note" && entry.line.text.startsWith(REREAD_COULD_NOT_START),
        ),
      ).toEqual([]);
      await service.request({ kind: "interviewStop", id: fresh.id });
    });
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

  it("keeps a line that was the whole of a turn and drops one the session talked over", async () => {
    // "I'll look at what's here first" and "Yes — the second node is the
    // migration" arrive the same way, and only what comes after says which it
    // was. A line the session then worked past was it announcing itself, which
    // the dock's own indicator says better and keeps saying; a line with
    // nothing after it is the answer, and dropping it loses the turn (D-102).
    const { service, repoId, id } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);

    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    const plain = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said"),
    );
    const answer = plain.at(-1)!.line;
    expect(answer.kind === "said" && answer.text, "the answer is kept").toBe(
      "You said: why two nodes?",
    );

    await service.request({ kind: "interviewTurn", id, text: "think out loud then answer" });
    const both = await spoken(service, id, (entries) =>
      entries.some(
        (entry) => entry.line.kind === "said" && entry.line.text.includes("think out loud"),
      ),
    );
    const since = both.slice(plain.length);
    // The opening goes; everything after the session started working stays,
    // because a line in the middle of a turn is the work being reported and
    // dropping it would lose the middle of every turn.
    expect(kinds(since)).toEqual(["turn", "tool", "said", "tool", "said"]);
    expect(JSON.stringify(since), "the opening").not.toContain("look at what's here first");
    expect(
      since.some((entry) => entry.line.kind === "said" && entry.line.text === "Node 2 is the cutover."),
      "the middle of the turn",
    ).toBe(true);
    await service.request({ kind: "interviewStop", id });
  });

  it("says the spec moved where a turn moved both, and says nothing where it moved one", async () => {
    // The two are one document in two places, and the interview writes both
    // when a change asks for it (D-103). The spec is on another pane, so a
    // person watching the chat never sees that half land — and what approving
    // freezes is read from the contract, so they need it before they confirm.
    const { service, repoId, id } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);

    // A turn that changes the plan alone has nothing extra to report. Waited
    // out to its end rather than to its last line: what a turn moved is read
    // once the turn is over, and a second turn sent over the top of the first
    // is measured against a spec the first had already moved.
    await service.request({ kind: "interviewTurn", id, text: "plan only please" });
    const first = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said" && entry.line.text.includes("plan only")),
    );
    expect(
      first.some((entry) => entry.line.kind === "note" && entry.line.text.includes("spec changed")),
      "nothing to say about a spec that did not move",
    ).toBe(false);
    await settled(service, id);

    await service.request({ kind: "interviewTurn", id, text: "change both of them" });
    const said = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text.includes("spec changed")),
    );
    const note = said.findLast((entry) => entry.line.kind === "note")!.line;
    expect(note.kind === "note" && note.notable, "drawn to be read, not buried").toBe(true);
    expect(note.kind === "note" && note.text).toContain("Spec pane");
    await service.request({ kind: "interviewStop", id });
  });

  it("says the spec is being written, and hands it over once it is", async () => {
    // The interview writes the spec and stops (D-102). The spec is a pane
    // away, so the chat says the writing is happening while it is; and once
    // the bytes are there it says so too, in words and no button — the press
    // that drafts the plan is at the foot of the Spec pane, and the note says
    // where it is rather than putting a second one here.
    const { service, repoId, id, changes } = await writing();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "please write the spec" });
    const said = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC),
    );
    const notes = said.flatMap((entry) => (entry.line.kind === "note" ? [entry.line] : []));
    // The writing is said while it happens, on the status line and not as a
    // line of the conversation, which it would outlast.
    const writingAt = changes.findIndex(
      (change) => change.kind === "interview" && change.sessionId === id && change.doing === "writing_the_spec",
    );
    const noteAt = changes.findIndex(
      (change) =>
        change.kind === "interview" &&
        change.entry?.line.kind === "note" &&
        change.entry.line.text === INTERVIEW_WROTE_THE_SPEC,
    );
    expect(writingAt, "the writing is said while it happens").toBeGreaterThanOrEqual(0);
    expect(notes.some((note) => note.text === "Writing the spec…")).toBe(false);
    const written = notes.at(-1)!;
    expect(written.text).toBe(
      "The spec is written: read it, change it on the Spec pane or by asking here, or press Generate plan.",
    );
    expect(written.notable, "drawn to be read, not buried").toBe(true);
    // And in that order: the one that says it is happening comes first.
    expect(writingAt).toBeLessThan(noteAt);
    await service.request({ kind: "interviewStop", id });
  });

  it("hands the spec over while the session is still composing, and says it once", async () => {
    // The write lands and the session goes on writing prose about it, often
    // for as long again. What the person is waiting for is already readable,
    // so the chat says so then rather than at the turn's end — and the note
    // that says it is the same one, said once however many endings come after
    // it (D-102).
    // A short gap, so the reading after the write is provably what speaks:
    // the turn never ends, so nothing else can.
    const { service, repoId, id } = await writing(undefined, { specSettleMs: 20 });
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    // The fake writes the file, announces the write and then never ends the
    // turn: the middle of a turn, held open.
    await service.request({ kind: "interviewTurn", id, text: "write and hang" });
    const handed = (lines: InterviewEntry[]): InterviewEntry[] =>
      lines.filter((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC);
    const said = await spoken(service, id, (entries) => handed(entries).length > 0);
    const note = handed(said).at(-1)!.line;
    expect(note.kind).toBe("note");
    expect(note.kind === "note" && note.text).toBe(
      "The spec is written: read it, change it on the Spec pane or by asking here, or press Generate plan.",
    );
    expect(note.kind === "note" && note.notable, "drawn to be read, not buried").toBe(true);
    // Mid-turn, which is the whole point: the session still owes the person a
    // word and the spec is already theirs to read; Generate plan waits for
    // the turn to end.
    expect(
      ((await service.snapshot()).working ?? []).includes(id),
      "said before the turn is over, not at its end",
    ).toBe(true);

    // And the endings that come after this do not say it again: the stop, and
    // the child going.
    await service.request({ kind: "interviewStop", id });
    await waitFor(async () => expect((await service.snapshot()).interviews).toEqual([]));
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    expect(handed(after).length, "one piece of news, said once").toBe(1);
  });

  it("says nothing about a spec the turn left where it was", async () => {
    // What the person is told is that the file moved, which is read off the
    // bytes rather than off the session saying it wrote. A turn that wrote
    // somewhere else has nothing to hand over, and neither has an admitted
    // write that put the same text back.
    const { service, repoId, id, changes } = await writing();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    const handed = (lines: InterviewEntry[]): InterviewEntry[] =>
      lines.filter((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC);

    await service.request({ kind: "interviewTurn", id, text: "write elsewhere" });
    await settled(service, id);
    expect(
      handed((await service.request({ kind: "editingRead", id })).conversation).length,
      "a write outside the spec is not the spec being written",
    ).toBe(0);

    await service.request({ kind: "interviewTurn", id, text: "rewrite the same spec" });
    await settled(service, id);
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    expect(doings(changes, id), "the write was admitted and said").toContain("writing_the_spec");
    expect(handed(after).length, "the bytes did not move, so there is no news").toBe(0);
    await service.request({ kind: "interviewStop", id });
  });

  it("says the spec is being written on the status line, and hands it over once a turn however many writes it admits", async () => {
    // The session admits one write event per call, and a turn that writes the
    // file and then edits it again admits two. The person is waiting through
    // the same thing either way: the status line says so while it lasts and
    // leaves nothing behind in the conversation, and the spec is handed over
    // once.
    const { service, repoId, id, changes } = await writing();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    const writings = (lines: InterviewEntry[]): number =>
      lines.filter((entry) => entry.line.kind === "note" && entry.line.text === "Writing the spec…")
        .length;
    const handed = (lines: InterviewEntry[]): number =>
      lines.filter((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC).length;
    await service.request({ kind: "interviewTurn", id, text: "write it twice please" });
    const first = await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC),
    );
    expect(writings(first)).toBe(0);
    expect(doings(changes, id)).toContain("writing_the_spec");
    await settled(service, id);
    // And the spec is handed over once, against the same two writes — the
    // turn ending after it does not say it again.
    expect(handed((await service.request({ kind: "editingRead", id })).conversation)).toBe(1);
    expect(doings(changes, id).at(-1), "the line goes as the turn ends").toBeNull();

    // Held for the turn and not for the session: the next turn's spec is news
    // again, because the person waits through it again.
    await service.request({ kind: "interviewTurn", id, text: "write it twice more" });
    await settled(service, id);
    expect(handed((await service.request({ kind: "editingRead", id })).conversation)).toBe(2);
    await service.request({ kind: "interviewStop", id });
  });

  it("drops what the session says after the spec is handed over, until the person speaks", async () => {
    // The note says the spec is written and where to go from it. A closing
    // line of the session's own after it says the same thing less well, and
    // two outputs saying one thing is the chat repeating itself (D-102).
    const { service, repoId, id } = await writing(undefined, { specSettleMs: 20 });
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write then talk" });
    await settled(service, id);
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    expect(after.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC)).toBe(true);
    expect(after.some((entry) => entry.line.kind === "said")).toBe(false);
    // The next turn is answered as any turn is.
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said" && entry.line.text === "You said: why two nodes?"),
    );
    await service.request({ kind: "interviewStop", id });
  });

  it("says no closing line ahead of the note when it lands before the reading after the write", async () => {
    // The reading that hands the spec over is taken a moment after the write
    // (SPEC_SETTLES_IN_MS), and a closing line can arrive inside that moment.
    // It waits on the reading: the note is the turn's last line and the line
    // is never shown (D-102).
    const { service, repoId, id, changes } = await writing();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write then close" });
    await settled(service, id);
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    const last = after.at(-1)!.line;
    expect(last.kind === "note" && last.text).toBe(INTERVIEW_WROTE_THE_SPEC);
    expect(after.some((entry) => entry.line.kind === "said")).toBe(false);
    expect(
      changes.some(
        (change) =>
          change.kind === "interview" && change.sessionId === id && change.entry?.line.kind === "said",
      ),
      "never pushed to the dock either",
    ).toBe(false);
    // Where the reading finds the spec unmoved there is no note, and the line
    // it waited on is said.
    await service.request({ kind: "interviewTurn", id, text: "rewrite then close" });
    await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said" && entry.line.text === "That is the spec as I have it."),
    );
    await service.request({ kind: "interviewStop", id });
  });

  it("shows the lines of a turn the person queued after the note", async () => {
    // The note silences the rest of its own turn, not the person's next one:
    // a turn sent while the first is still in flight is answered as any is.
    const { service, repoId, id } = await writing(undefined, { specSettleMs: 20 });
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write and hang" });
    await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC),
    );
    expect(((await service.snapshot()).working ?? []).includes(id), "the first turn is still in flight").toBe(true);
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    await spoken(service, id, (entries) =>
      entries.some((entry) => entry.line.kind === "said" && entry.line.text === "You said: why two nodes?"),
    );
    await service.request({ kind: "interviewStop", id });
  });

  it("says a line of the session's is on its way while it holds one, and nothing once it is said", async () => {
    // The turn's opening line is held until the turn shows what it was, and
    // meanwhile the dock puts the session's bubble up with its dots (D-119).
    // A line after work is said as it arrives, and nothing is held for it.
    const { service, repoId, id, changes } = await planning();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    let from = changes.length;
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    await settled(service, id);
    let said = doings(changes.slice(from), id);
    expect(said, said.join(", ")).toContain("speaking");
    expect(said.at(-1)).toBeNull();
    from = changes.length;
    await service.request({ kind: "interviewTurn", id, text: "split the node" });
    await settled(service, id);
    said = doings(changes.slice(from), id);
    expect(said, said.join(", ")).not.toContain("speaking");
    expect(said.at(-1)).toBeNull();
    await service.request({ kind: "interviewStop", id });
  });

  it("hands the spec over when the person stops before the write has been read", async () => {
    // A person who stops a turn that had already written the spec still has
    // the spec, so the way on is still theirs. The reading after the write is
    // the usual way they are told; where the stop comes first it is the stop
    // that tells them, and the reading it was still owed is dropped.
    //
    // A gap long enough that the reading cannot be what speaks here: the note
    // this asserts on can only have come from the stop.
    const { service, repoId, id, changes } = await writing(undefined, { specSettleMs: 60_000 });
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write and hang" });
    // The fake writes the file before it announces the write, so the status
    // saying so is proof the bytes are on disk.
    await writingSaid(changes, id);

    await service.request({ kind: "interviewStop", id });
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    const handed = after.filter(
      (entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC,
    );
    expect(handed.length, "said once, by whichever of the two got there").toBe(1);
    const note = handed[0]!.line;
    expect(note.kind === "note" && note.notable, "drawn to be read, not buried").toBe(true);
  });

  it("stops the interview before it drafts, behind the pane that holds the press mid-turn", async () => {
    // The Spec pane holds Generate plan while a turn is in flight (D-102).
    // Behind it the host stops the child — which winds a turn still there up
    // and hands the spec over — and then reads the file that turn left
    // behind, so a caller that pressed mid-turn anyway drafts from a spec the
    // chat has finished with.
    const events: string[] = [];
    let planning: { service: DesktopService; repoId: string; id: string; changes: Change[] } | null = null;
    const runs: typeof runProcess = async (binary, args, options) => {
      if (!args.includes("--from-spec")) return runProcess(binary, args, options);
      // Read at the moment the drafter is invoked, which is what makes the
      // order observable: a stop that came after this would leave the turn
      // still owed here.
      const owed = ((await planning!.service.snapshot()).working ?? []).includes(planning!.id);
      events.push(owed ? "drafted with the turn still owed" : "drafted with the turn wound up");
      return { code: 1, stdout: "", stderr: "no drafter in this fixture", cancelled: false };
    };
    planning = await writing(runs);
    const { service, repoId, id, changes } = planning;
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    // A turn that writes the spec and then never ends: the state a person is
    // in when they have read enough and want the plan from it.
    await service.request({ kind: "interviewTurn", id, text: "write and hang" });
    await writingSaid(changes, id);
    expect((await service.snapshot()).working ?? []).toContain(id);

    const held = await finished(
      service,
      (await service.request({ kind: "generatePlan", repoId, id })).id,
    );
    expect(events).toEqual(["drafted with the turn wound up"]);
    // The turn is over and the stop said what it always says: the spec is
    // drafted and the way on from it is the person's.
    expect((await service.snapshot()).working ?? []).not.toContain(id);
    const after = (await service.request({ kind: "editingRead", id })).conversation;
    expect(
      after.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC),
    ).toBe(true);
    // The fixture has no drafter behind `admit`, so the job itself fails; what
    // this test is about is what had already happened by the time it ran.
    expect(held.state).toBe("failed");
  });

  describe("the name a plan is drafted under (D-127)", () => {
    const specAt = (repo: string): string => join(repo, "specs", "activation-email", "spec.md");
    const titleLine = (repo: string): string => readFileSync(specAt(repo), "utf8").split("\n")[0]!;
    const ticketTitle = (repo: string, key: string): string =>
      (JSON.parse(readFileSync(join(repo, ".perbo", "tickets", `${key}.json`), "utf8")) as { title: string })
        .title;
    /** A planning with a spec the person titled, drafted by `admit` proposing "Welcome emails". */
    async function titled(): Promise<{
      service: DesktopService;
      repo: string;
      repoId: string;
      id: string;
      changes: Change[];
      asked: string[][];
    }> {
      let repo = "";
      const asked: string[][] = [];
      const made = await writing(naming(() => repo, "Welcome emails", asked));
      repo = made.repo;
      return { ...made, asked };
    }
    const generate = async (service: DesktopService, repoId: string, id: string): Promise<Job> => {
      const job = await finished(service, (await service.request({ kind: "generatePlan", repoId, id })).id);
      expect(job.state, job.error ?? "").toBe("completed");
      return job;
    };

    it("keeps the name the person gave the spec for the ticket and the spec", async () => {
      const { service, repo, repoId, id, asked } = await titled();
      expect((await service.request({ kind: "editingRead", id })).named).toEqual({
        by: "person",
        title: "Activation email",
      });
      const job = await generate(service, repoId, id);
      expect(asked[0]).toContain("--keep-title");
      expect(ticketTitle(repo, job.resultKey!)).toBe("Activation email");
      expect(titleLine(repo)).toBe("# Activation email");
    });

    it("takes the drafter's name where the Architect titled the spec last, and the spec takes it", async () => {
      const { service, repo, repoId, id, asked } = await titled();
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      await service.request({ kind: "interviewTurn", id, text: "title the spec" });
      await settled(service, id);
      expect((await service.request({ kind: "editingRead", id })).named).toEqual({
        by: "architect",
        title: "Activation email on signup",
      });
      const job = await generate(service, repoId, id);
      expect(asked[0]).not.toContain("--keep-title");
      expect(ticketTitle(repo, job.resultKey!)).toBe("Welcome emails");
      expect(titleLine(repo)).toBe("# Welcome emails");
    });

    it("names the planning by the Architect's title the moment the write settles, before the turn ends (D-118)", async () => {
      const { service, repoId, id } = await writing(undefined, { specSettleMs: 20 });
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      await service.request({ kind: "interviewTurn", id, text: "title and hang" });
      await waitFor(async () =>
        expect((await service.request({ kind: "editingRead", id })).named).toEqual({
          by: "architect",
          title: "Activation email on signup",
        }),
      );
      expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === id)?.title).toBe(
        "Activation email on signup",
      );
      // And the turn is still going.
      expect((await service.snapshot()).working ?? []).toContain(id);
      await service.request({ kind: "interviewStop", id });
    });

    it("keeps the name the person gives while a turn runs that leaves the title alone", async () => {
      const { service, repo, repoId, id, changes, asked } = await titled();
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      await service.request({ kind: "interviewTurn", id, text: "write and hang" });
      await writingSaid(changes, id);
      const read = await service.request({ kind: "specRead", id });
      await saveSpec(service, { kind: "specSave", id, repoId, title: "Signup emails", sections: read.sections });
      // Generate plan stops the turn, which ends with the title the person gave.
      const job = await generate(service, repoId, id);
      expect((await service.request({ kind: "editingRead", id })).named).toEqual({
        by: "person",
        title: "Signup emails",
      });
      expect(asked[0]).toContain("--keep-title");
      expect(ticketTitle(repo, job.resultKey!)).toBe("Signup emails");
      expect(titleLine(repo)).toBe("# Signup emails");
    });

    it("names nobody for a save that only respaces the title, and reads the drafts again for it as for any save", async () => {
      const { service, repo, repoId, id, changes, asked } = await titled();
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      await service.request({ kind: "interviewTurn", id, text: "title the spec" });
      await settled(service, id);
      const read = await service.request({ kind: "specRead", id });
      const listed = (): number =>
        changes.filter((change) => change.kind === "editing" && change.sessionId === id).length;
      // What a save under the title it read announces, which a respaced one
      // matches: every save that lands has the drafts list read again, since
      // the contract tab holds by the spec's sections
      // (D-NEW-basic-and-epic-flows).
      const unchanged = listed();
      await saveSpec(service, { kind: "specSave", id, repoId, title: read.title, sections: read.sections });
      const respaced = listed();
      expect(respaced).toBeGreaterThan(unchanged);
      await saveSpec(service, {
        kind: "specSave",
        id,
        repoId,
        title: "  Activation   email on signup ",
        sections: read.sections,
      });
      expect(listed() - respaced).toBe(respaced - unchanged);
      expect((await service.request({ kind: "editingRead", id })).named).toEqual({
        by: "architect",
        title: "Activation email on signup",
      });
      const job = await generate(service, repoId, id);
      expect(asked[0]).not.toContain("--keep-title");
      expect(ticketTitle(repo, job.resultKey!)).toBe("Welcome emails");
    });

    it("keeps the person's name again once they retitle the spec after the Architect", async () => {
      const { service, repo, repoId, id, asked } = await titled();
      await service.request({ kind: "interviewStart", repoId, id });
      await running(service, id);
      await service.request({ kind: "interviewTurn", id, text: "title the spec" });
      await settled(service, id);
      const read = await service.request({ kind: "specRead", id });
      await saveSpec(service, { kind: "specSave", id, repoId, title: "Signup emails", sections: read.sections });
      const job = await generate(service, repoId, id);
      expect(asked[0]).toContain("--keep-title");
      expect(ticketTitle(repo, job.resultKey!)).toBe("Signup emails");
      expect(titleLine(repo)).toBe("# Signup emails");
    });
  });

  it("drafts from the spec a stopped turn writes before its child exits", async () => {
    // A stop ends the chat's stdin, and the session finishes the turn it is in
    // after that, so the turn can still write the spec until the child exits.
    // The press waits for the exit: the draft reads the file the turn left
    // behind (D-102), and what `admit` reads is what it titles, hashes and
    // seeds the plan's reading against its spec with.
    const read: { spec: string; running: boolean }[] = [];
    let planning: { service: DesktopService; id: string } | null = null;
    const runs: typeof runProcess = async (binary, args, options) => {
      const at = args.indexOf("--from-spec");
      if (at < 0) return runProcess(binary, args, options);
      // The bytes `admit` is handed, at the moment it is invoked.
      read.push({
        spec: readFileSync(join(args[args.indexOf("--repo") + 1]!, args[at + 1]!), "utf8"),
        running: ((await planning!.service.snapshot()).interviews ?? []).includes(planning!.id),
      });
      return { code: 1, stdout: "", stderr: "no drafter in this fixture", cancelled: false };
    };
    const made = await writing(runs);
    planning = made;
    const { service, repoId, id, changes } = made;
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write as it winds down" });
    await writingSaid(changes, id);

    await finished(service, (await service.request({ kind: "generatePlan", repoId, id })).id);
    expect(read).toHaveLength(1);
    expect(read[0]!.spec).toContain("And the spec says so.");
    expect(read[0]!.spec, "the write the turn made after its stdin closed").toContain(
      "Written as the turn wound down.",
    );
    expect(read[0]!.running, "the chat had exited when the draft began").toBe(false);
  });

  /**
   * A chat on the planning mid-turn that writes the spec once more after its
   * stdin closes, as soon as the spec folder has gone, and then exits: the
   * turn a delete has to wait out, since a delete that removes the folder
   * first has it written back.
   */
  async function windingDown(): Promise<Awaited<ReturnType<typeof writing>> & { folder: string }> {
    const made = await writing();
    await made.service.request({ kind: "interviewStart", repoId: made.repoId, id: made.id });
    await running(made.service, made.id);
    await made.service.request({ kind: "interviewTurn", id: made.id, text: "write back after a delete" });
    await writingSaid(made.changes, made.id);
    return { ...made, folder: join(made.repo, "specs", "activation-email") };
  }

  /** The spec folder, gone once the chat has exited and with it anything its turn writes. */
  async function staysGone(service: DesktopService, id: string, folder: string): Promise<void> {
    const until = Date.now() + 20_000;
    while (((await service.snapshot()).interviews ?? []).includes(id)) {
      if (Date.now() > until) throw new Error("The chat never exited");
      await delay(10);
    }
    expect(existsSync(folder), "the spec folder goes with the work, and no turn wrote it back").toBe(false);
  }

  it("stops the chat and waits out its turn before deleting the planning's spec", async () => {
    const { service, id, folder } = await windingDown();
    await service.request({ kind: "editingDiscard", id });
    expect((await service.snapshot()).interviews ?? [], "the chat has gone").not.toContain(id);
    await staysGone(service, id, folder);
  });

  it("stops the chat of a planning over a ticket deleted from its contract, and waits out its turn", async () => {
    // Deleting the work from the contract page discards the planning drafting
    // it, and the planning's chat goes with it (D-102): stopped, and exited
    // before the spec folder goes (D-129), or the turn it is in writes the
    // spec back into a folder the delete removed.
    const { service, repo, repoId, id, folder } = await windingDown();
    await finished(service, (await service.request({ kind: "admit", repoId, draft })).id);
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as {
      state: string;
      admission: { spec?: unknown };
    };
    ticket.state = "plan_review";
    ticket.admission.spec = {
      path: "specs/activation-email/spec.md",
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(at, JSON.stringify(ticket));
    // The planning takes the plan drafted from its spec as it is opened.
    expect(
      (await service.request({ kind: "editingOpen", target: { kind: "session", id } })).key,
    ).toBe("PRB-1");
    expect((await service.snapshot()).interviews ?? []).toContain(id);

    await service.request({ kind: "discard", repoId, key: "PRB-1" });
    expect((await service.request({ kind: "editingRead", id })).phase).toBe("discarded");
    expect((await service.snapshot()).interviews ?? [], "the chat has gone").not.toContain(id);
    await staysGone(service, id, folder);
  });

  it("refuses to draft a plan while a group of the interview's questions stands", async () => {
    // The answers change the spec the draft would read, so a plan drafted now
    // is drafted around a question the person can still see (D-117). Both
    // surfaces withhold the press; this is the line behind them, so neither
    // can be the one that counts for itself.
    const { service, repoId, id } = await writing();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "please write the spec" });
    await settled(service, id);
    await service.request({ kind: "interviewTurn", id, text: "ask me" });
    await settled(service, id);
    expect((await service.request({ kind: "editingRead", id })).asking).not.toBeNull();

    const held = await finished(
      service,
      (await service.request({ kind: "generatePlan", repoId, id })).id,
    );
    expect(held.state).toBe("failed");
    expect(held.error).toBe(
      "Answer the chat's questions first — its answers change the spec this drafts from.",
    );
    expect((await service.request({ kind: "editingRead", id })).key).toBeNull();
    await service.request({ kind: "interviewStop", id });
  });

  it("refuses to draft over a group of questions the turn puts as it winds down after the press", async () => {
    // The press stops the chat and waits for it to exit, and the turn it was
    // in can put a group of its own in that time. That group holds the draft
    // as one standing before the press does (D-117).
    let drafts = 0;
    const runs: typeof runProcess = async (binary, args, options) => {
      if (!args.includes("--from-spec")) return runProcess(binary, args, options);
      drafts += 1;
      return { code: 1, stdout: "", stderr: "no drafter in this fixture", cancelled: false };
    };
    const { service, repoId, id, changes } = await writing(runs);
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "ask as it winds down" });
    await writingSaid(changes, id);
    expect((await service.request({ kind: "editingRead", id })).asking, "nothing stands at the press").toBeNull();

    const held = await finished(
      service,
      (await service.request({ kind: "generatePlan", repoId, id })).id,
    );
    expect(held.state).toBe("failed");
    expect(held.error).toBe(
      "Answer the chat's questions first — its answers change the spec this drafts from.",
    );
    expect(drafts, "nothing was drafted").toBe(0);
    const after = await service.request({ kind: "editingRead", id });
    expect(after.asking, "the group the turn put as it wound down").not.toBeNull();
    expect(after.key).toBeNull();
  });

  it("leaves a planning whose first draft the drafter refused editable, so the next press drafts again", async () => {
    // The chat writes and rewrites the spec, and the drafter refuses what it
    // wrote. The refusal is the planning's error and nothing was admitted, so
    // the Spec pane's next press is taken rather than refused unseen: a spec
    // drafts one plan, and the CLI refuses a second ticket from it.
    let drafts = 0;
    const runs: typeof runProcess = async (binary, args, options) => {
      if (!args.includes("--from-spec")) return runProcess(binary, args, options);
      drafts += 1;
      return {
        code: 1,
        stdout: "",
        stderr: "error: the spec's Requirements section names no requirement.",
        cancelled: false,
      };
    };
    const { service, repoId, id } = await writing(runs);
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "please write the spec" });
    await settled(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write the spec again" });
    await settled(service, id);

    const press = async (): Promise<void> => {
      const before = await service.request({ kind: "editingRead", id });
      const submitted = await service.request({
        kind: "editingSubmit",
        id,
        revision: before.revision,
        operationId: randomUUID(),
        intent: "generate",
      });
      await finished(service, submitted.operation!.jobId!);
      for (let count = 0; count < 200; count++) {
        if ((await service.request({ kind: "editingRead", id })).operation?.reconciled) return;
        await delay(10);
      }
      throw new Error("The draft was never reconciled");
    };
    await press();
    const refused = await service.request({ kind: "editingRead", id });
    expect(refused).toMatchObject({ phase: "editing", key: null });
    expect(refused.error).toContain("names no requirement");
    await press();
    expect(drafts).toBe(2);
  });

  it("leaves a planning whose first draft was stopped editable, so the next press drafts again", async () => {
    // A stop before any ticket is read back admitted nothing, and a spec
    // drafts one plan, so the Spec pane's next press is taken again.
    let drafts = 0;
    const runs: typeof runProcess = async (binary, args, options) => {
      if (!args.includes("--from-spec")) return runProcess(binary, args, options);
      drafts += 1;
      if (drafts > 1) return { code: 1, stdout: "", stderr: "error: no drafter in this fixture", cancelled: false };
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { code: 1, stdout: "", stderr: "", cancelled: true };
    };
    const { service, id } = await writing(runs);
    const submit = async (): Promise<string> => {
      const before = await service.request({ kind: "editingRead", id });
      const submitted = await service.request({
        kind: "editingSubmit",
        id,
        revision: before.revision,
        operationId: randomUUID(),
        intent: "generate",
      });
      return submitted.operation!.jobId!;
    };
    const reconciled = async (): Promise<void> => {
      for (let count = 0; count < 200; count++) {
        if ((await service.request({ kind: "editingRead", id })).operation?.reconciled) return;
        await delay(10);
      }
      throw new Error("The draft was never reconciled");
    };
    const job = await submit();
    for (let count = 0; count < 200 && drafts === 0; count++) await delay(10);
    await service.request({ kind: "editingStop", id });
    expect((await finished(service, job)).state).toBe("cancelled");
    await reconciled();
    const stopped = await service.request({ kind: "editingRead", id });
    expect(stopped).toMatchObject({ phase: "editing", key: null });
    expect(stopped.operation?.state).toBe("cancelled");
    await finished(service, await submit());
    await reconciled();
    expect(drafts).toBe(2);
  });

  it("hands the plan over only where the turn moved the spec and there is no plan yet", async () => {
    // A turn that only talks moved nothing, so there is nothing to hand over.
    const alone = await writing();
    await alone.service.request({ kind: "interviewStart", repoId: alone.repoId, id: alone.id });
    await running(alone.service, alone.id);
    await alone.service.request({ kind: "interviewTurn", id: alone.id, text: "why two nodes?" });
    await settled(alone.service, alone.id);
    const quiet = (await alone.service.request({ kind: "editingRead", id: alone.id })).conversation;
    expect(quiet.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC)).toBe(false);
    await alone.service.request({ kind: "interviewStop", id: alone.id });
    // And a spec written beside a plan that already exists is a change to
    // that plan, which the spec-moved note reports instead: there is no plan
    // to generate.
    const drafted = await planning();
    await drafted.service.request({ kind: "interviewStart", repoId: drafted.repoId, id: drafted.id });
    await running(drafted.service, drafted.id);
    await drafted.service.request({ kind: "interviewTurn", id: drafted.id, text: "please write the spec" });
    await settled(drafted.service, drafted.id);
    const beside = (await drafted.service.request({ kind: "editingRead", id: drafted.id })).conversation;
    expect(doings(drafted.changes, drafted.id)).toContain("writing_the_spec");
    expect(beside.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC)).toBe(false);
    await drafted.service.request({ kind: "interviewStop", id: drafted.id });
  });

  it("records what a turn changed of the spec and the plan as the last change, each turn replacing the one before", async () => {
    // The panes mark the last change to the pair (D-128):
    // what the turn wrote in the spec, and what it edited in the plan
    // through the CLI's edit path, compared before and after the turn.
    const { service, repoId, id } = await planning();
    // The planning's first spec save writes into empty sections, which is
    // not a change: the planning opens with nothing marked.
    expect((await service.request({ kind: "editingRead", id })).change).toBeNull();
    // A save that rewords the outcome and writes the first note into empty
    // Notes: the outcome is a change, and the note's first writing is not, so
    // its before is its after. The turn below that adds to the notes edits
    // words that were there.
    await saveSpec(service, {
      kind: "specSave", id, repoId, title: "Activation email",
      sections: { ...SECTIONS, outcome: SECTIONS.outcome + " Always.", notes: "A note." },
    });
    const standing = (await service.request({ kind: "editingRead", id })).change;
    // The person's own, by hand: recorded, and marked nowhere.
    expect(standing!.by).toBe("person");
    expect(standing!.spec!.before.notes).toBe("A note.");
    expect(standing!.spec!.before.outcome).not.toBe(standing!.spec!.after.outcome);
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    // A turn that only talks changes nothing, and records nothing: the last
    // change stands as it was.
    await service.request({ kind: "interviewTurn", id, text: "why two nodes?" });
    await settled(service, id);
    expect((await service.request({ kind: "editingRead", id })).change).toEqual(standing);
    // A turn that writes the spec: the sections before and after, and no plan side.
    await service.request({ kind: "interviewTurn", id, text: "change both of them" });
    await settled(service, id);
    let change = (await service.request({ kind: "editingRead", id })).change;
    expect(change).not.toBeNull();
    // The chat's, which is what the panes mark.
    expect(change!.by).toBe("chat");
    expect(change!.plan).toBeNull();
    expect(change!.spec).not.toBeNull();
    expect(JSON.stringify(change!.spec!.before)).not.toContain("And the button says so.");
    expect(JSON.stringify(change!.spec!.after)).toContain("And the button says so.");
    expect(change!.spec!.before.requirements).toBe(change!.spec!.after.requirements);
    expect(change!.spec!.before.outcome).toBe(change!.spec!.after.outcome);
    // A turn that edits the plan through `perbo edit`: the promise before and
    // after, and — the whole record replaced — no spec side left from the
    // turn before.
    await service.request({ kind: "interviewTurn", id, text: "please reword the plan" });
    await settled(service, id);
    change = (await service.request({ kind: "editingRead", id })).change;
    expect(change!.by).toBe("chat");
    expect(change!.spec).toBeNull();
    expect(change!.plan).not.toBeNull();
    expect(change!.plan!.before.criteria.find((each) => each.id === "ac_1")?.text).toBe("A signup queues one email");
    expect(change!.plan!.after.criteria.find((each) => each.id === "ac_1")?.text).toBe("A signup queues exactly one email");
    expect(change!.plan!.before.outcome).toBe(change!.plan!.after.outcome);
    await service.request({ kind: "interviewStop", id });
  });

  it("records an edit by hand, a basic ticket's contract written through and a spec save as the last change, the person's, and nothing where nothing differs", async () => {
    // Each way a person moves the pair by hand lands as the one change,
    // recorded as theirs, which the panes mark nowhere and which replaces the
    // chat's marks (D-128); it replaces the one before it whole; an edit that
    // moves no promise and a save of the same words leave the last change
    // standing.
    const { service, repoId, id } = await planning();
    const read = async () => (await service.request({ kind: "editingRead", id })).change;
    const graphEdit = async (edit: GraphEdit) =>
      finished(service, (await service.request({ kind: "graphEdit", repoId, key: "PRB-1", edit })).id);
    // The first spec save, which the planning opened with, is the spec's first writing and records nothing.
    expect(await read()).toBeNull();
    // A criterion reworded on the Graph pane: the promise before and after, and no spec side.
    expect(await graphEdit({
      op: "set_criterion", id: "ac_1", text: "A signup queues exactly one email",
      expected_verification: { kind: "test", assertion: "signup.test.ts" },
    })).toMatchObject({ state: "completed", error: null });
    const reworded = await read();
    expect(reworded!.by).toBe("person");
    expect(reworded!.spec).toBeNull();
    expect(reworded!.plan!.before.criteria.map((each) => each.text)).toEqual(["A signup queues one email", "A failed send is retried"]);
    expect(reworded!.plan!.after.criteria.map((each) => each.text)).toEqual(["A signup queues exactly one email", "A failed send is retried"]);
    expect(reworded!.plan!.before.outcome).toBe(reworded!.plan!.after.outcome);
    // A basic ticket's contract written through, which is the `edit` request over the flat plan: the promise before and after.
    const detail = await service.detail(repoId, "PRB-1");
    expect(await finished(service, (await service.request({
      kind: "edit", repoId, key: "PRB-1", digest: detail.digest,
      draft: {
        ...twoCriteria,
        criteria: [
          { text: "A signup queues exactly one email", assertion: "signup.test.ts", kind: "test" },
          { text: "A failed send is retried twice", assertion: "retry.test.ts", kind: "test" },
        ],
      },
    })).id)).toMatchObject({ state: "completed", error: null });
    const next = await read();
    expect(next!.by).toBe("person");
    expect(next!.spec).toBeNull();
    expect(next!.plan!.before.criteria.map((each) => each.text)).toEqual(["A signup queues exactly one email", "A failed send is retried"]);
    expect(next!.plan!.after.criteria.map((each) => each.text)).toEqual(["A signup queues exactly one email", "A failed send is retried twice"]);
    // A spec save that rewords a requirement: the sections before and after, no plan side, and the plan's change gone with the record it was in.
    const rewordedSpec = { ...SECTIONS, requirements: "- A signup queues exactly one email.\n- A failed send is retried." };
    await saveSpec(service, { kind: "specSave", id, repoId, title: "Activation email", sections: rewordedSpec });
    const saved = await read();
    expect(saved!.by).toBe("person");
    expect(saved!.plan).toBeNull();
    // As the file says them, ids and all: what the panes diff is the file's text.
    expect(saved!.spec!.before.requirements).toContain("queues one email.");
    expect(saved!.spec!.before.requirements).not.toContain("exactly");
    expect(saved!.spec!.after.requirements).toContain("queues exactly one email.");
    expect(saved!.spec!.before.outcome).toBe(saved!.spec!.after.outcome);
    // The same words saved again change nothing, and record nothing.
    await saveSpec(service, { kind: "specSave", id, repoId, title: "Activation email", sections: rewordedSpec });
    expect(await read()).toEqual(saved);
    // An edit that only arranges the graph moves no promise, and records nothing: the last change stands.
    expect(await graphEdit({ op: "add_node", title: "Queue one email", criteria: ["ac_1"], new_criteria: [], paths: ["packages/auth/**"] })).toMatchObject({ state: "completed", error: null });
    expect(await read()).toEqual(saved);
  });

  it("marks a criterion as long as the contract allows, and says in the chat where a change cannot be marked, without failing what made it", async () => {
    // The record of a change is bounded as the contract is and no tighter:
    // a criterion the contract holds is marked, however long. And where the
    // record will not take the change — a spec section past what it holds —
    // the marking is said in the chat, and the turn or the edit that made the
    // change is not failed for it.
    const { service, repoId, id } = await planning();
    const read = async () => (await service.request({ kind: "editingRead", id })).change;
    // Notes with words in, so the long write below is an edit of them rather
    // than their first writing, which is not a change and is never recorded.
    await saveSpec(service, { kind: "specSave", id, repoId, title: "Activation email", sections: { ...SECTIONS, notes: "A note." } });
    const long = "A signup queues exactly one email, and never two, however the retry goes. ".repeat(5).trim();
    expect(long.length).toBeGreaterThan(200);
    const job = await finished(service, (await service.request({
      kind: "graphEdit", repoId, key: "PRB-1",
      edit: { op: "set_criterion", id: "ac_1", text: long, expected_verification: { kind: "test", assertion: "signup.test.ts" } },
    })).id);
    expect(job).toMatchObject({ state: "completed", error: null });
    const marked = await read();
    expect(marked?.plan?.after.criteria[0]?.text).toBe(long);
    // A turn that writes 13,000 characters into the notes: the spec moved,
    // the record of the change refuses the section, and the chat says so.
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    await service.request({ kind: "interviewTurn", id, text: "write a long section" });
    await settled(service, id);
    expect(await read()).toEqual(marked);
    const session = await service.request({ kind: "editingRead", id });
    expect(session.conversation.some(
      (entry) => entry.line.kind === "note" && entry.line.text.startsWith("The change could not be marked on the panes:"),
    )).toBe(true);
    await service.request({ kind: "interviewStop", id });
  });

  it("does not measure a turn against a spec whose file was there and would not read", async () => {
    // A spec with no file yet is a spec of empty sections, whose first
    // writing marks nothing; a file that is there and cannot be read is no
    // reading at all, and nothing the turn did is measured against it, its
    // edit to the plan included.
    const { service, repoId, id, registered } = await planning();
    const read = async () => (await service.request({ kind: "editingRead", id })).change;
    // A standing change, which a turn measured against nothing would replace.
    await saveSpec(service, {
      kind: "specSave", id, repoId, title: "Activation email",
      sections: { ...SECTIONS, outcome: SECTIONS.outcome + " Always." },
    });
    const standing = await read();
    expect(standing!.spec!.before.outcome).not.toBe(standing!.spec!.after.outcome);
    expect(standing!.plan).toBeNull();
    await service.request({ kind: "interviewStart", repoId, id });
    await running(service, id);
    const slug = (await service.request({ kind: "editingRead", id })).specSlug!;
    const path = join(registered, "specs", slug, "spec.md");
    const markdown = readFileSync(path, "utf8");
    // A directory where the file was, which is there and will not read.
    rmSync(path);
    mkdirSync(path);
    // The fake interview rewords a criterion through `perbo edit`, so the
    // plan really moves in this turn.
    await service.request({ kind: "interviewTurn", id, text: "please reword the plan" });
    rmSync(path, { recursive: true });
    writeFileSync(path, markdown);
    await settled(service, id);
    expect(JSON.stringify((await service.detail(repoId, "PRB-1")).contract)).toContain("A signup queues exactly one email");
    expect(await read()).toEqual(standing);
    await service.request({ kind: "interviewStop", id });
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
      lines.some((line) => line.line.kind === "note" && line.line.text.includes("Writing ")),
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
  it("writes down when a ticket's page opened, and reads it back from the profile on disk", async () => {
    const { service, repo, options } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    await service.request({ kind: "ticketOpened", repoId: registered.id, key: "PRB-1" });
    const at = (await service.snapshot()).lastOpened?.[registered.id + ":PRB-1"];
    expect(at).toBeDefined();
    // Saved as it is written, not only when the app closes.
    expect(Profile.open(options.dataDirectory).state.lastOpened).toEqual({ [registered.id + ":PRB-1"]: at });
  });

  it("files nothing on its own, and archives and restores by hand as a preference", async () => {
    const { service, repo } = fixture();
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
    setTicketState(repo, "PRB-2", "merged");
    // Finished, and still on Home until a person files it.
    const snapshot = await service.snapshot();
    expect(snapshot.archived).toEqual([]);
    expect(snapshot.tasks.map((row) => row.ticket.key).sort()).toEqual([
      "PRB-1",
      "PRB-2",
    ]);
    await service.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-1", "PRB-2"],
      archived: true,
    });
    expect((await service.snapshot()).archived?.sort()).toEqual([
      registered.id + ":PRB-1",
      registered.id + ":PRB-2",
    ]);
    await service.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-1"],
      archived: false,
    });
    expect((await service.snapshot()).archived).toEqual([
      registered.id + ":PRB-2",
    ]);
    await expect(
      service.request({
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
      // The line under the title on its contract page.
      outcome: draft.outcome,
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
      usage.providers.find((provider) => provider.id === "claude"),
    ).toMatchObject({
      connected: true,
      plan: "Max",
      windows: [{ label: "5-hour limit", usedPercent: 9 }],
      detail: "Injected Claude.",
    });
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
        decisions: [{ findingKey: "a".repeat(64), choice: "approach" as const, answer: "Take the smaller change." }],
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
        form: { ...opened.form, draft: { ...draft, outcome } },
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
    // The job finishing and the key landing on the session are two steps, so
    // the read waits for the second rather than catching the moment between.
    const landed = await Promise.all(
      sessions.map(async (session) => {
        let read = await service.request({ kind: "editingRead", id: session.id });
        for (let tries = 0; tries < 400 && read.key === null; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          read = await service.request({ kind: "editingRead", id: session.id });
        }
        return read;
      }),
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

/**
 * `admit --from-spec` without a model.
 *
 * Drafting a plan from a spec is the one part of planning the desktop does not
 * own, so the fake admits the same work from criteria and records the spec on
 * the ticket, which is what the real command leaves behind.
 */
function drafting(
  repo: () => string,
  asked: string[][] = [],
  standing: boolean[] = [],
): typeof runProcess {
  return async (binary, args, options) => {
    const at = args.indexOf("--from-spec");
    if (args[1] !== "admit" || at < 0) return runProcess(binary, args, options);
    asked.push(args.slice(1, args.indexOf("--repo")));
    // Whether the stopped ticket was still there when the admission ran.
    standing.push(existsSync(join(repo(), ".perbo", "tickets", "PRB-1.json")));
    const result = await runProcess(
      binary,
      [
        args[0]!,
        "admit",
        "--prefix",
        "PRB",
        "--outcome",
        "Every import goes through the current parser",
        "--criterion",
        "An upload of either dialect is read :: importer.test.ts :: test",
        "--path",
        "packages/import/**",
        "--json",
        ...args.slice(args.indexOf("--repo")),
      ],
      options,
    );
    if (result.code !== 0) return result;
    const printed = JSON.parse(result.stdout) as { ticket: { key: string } };
    const path = join(repo(), ".perbo", "tickets", `${printed.ticket.key}.json`);
    const ticket = JSON.parse(readFileSync(path, "utf8")) as { admission: { spec?: unknown } };
    ticket.admission.spec = {
      path: args[at + 1]!,
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(path, JSON.stringify(ticket));
    return { ...result, stdout: JSON.stringify({ ticket }) };
  };
}

/**
 * `admit --from-spec` as {@link drafting} stands in for it, naming the ticket
 * as `admit` names it (D-127): with `--keep-title` after the spec's title,
 * which is left as it is; otherwise after the name the drafter proposed, which
 * the spec's title line takes.
 */
function naming(repo: () => string, proposed: string, asked: string[][] = []): typeof runProcess {
  const draft = drafting(repo, asked);
  return async (binary, args, options) => {
    const result = await draft(binary, args, options);
    const at = args.indexOf("--from-spec");
    if (args[1] !== "admit" || at < 0 || result.code !== 0) return result;
    const { ticket } = JSON.parse(result.stdout) as { ticket: { key: string; title: string } };
    const specAt = join(repo(), args[at + 1]!);
    const markdown = readFileSync(specAt, "utf8");
    if (args.includes("--keep-title")) ticket.title = /^# (.*)$/m.exec(markdown)![1]!;
    else {
      ticket.title = proposed;
      writeFileSync(specAt, markdown.replace(/^# .*$/m, `# ${proposed}`));
    }
    writeFileSync(join(repo(), ".perbo", "tickets", `${ticket.key}.json`), JSON.stringify(ticket));
    return { ...result, stdout: JSON.stringify({ ticket }) };
  };
}

describe("the plan read against the spec (D-128)", () => {
  /** What `perbo drift KEY --json` prints, as the canned CLI answers it. */
  const verdict = (findings: unknown[], dismissed = false) => ({
    key: "PRB-1",
    spec: "sha256:" + "a".repeat(64),
    promises: "sha256:" + "b".repeat(64),
    origin: "read",
    findings,
    dismissed,
    checked_at: "2026-09-21T10:00:00.000Z",
    model: null,
    cached: false,
  });
  const finding = {
    heading: "Criterion 1 and R1",
    difference: "R1 asks for one email; criterion 1 promises two.",
    options: [
      { label: "Reword criterion 1 to say one email is queued.", detail: null, recommended: true },
      { label: "Change R1 in the spec to ask for two emails.", detail: null, recommended: false },
    ],
  };
  /**
   * The CLI, with `drift` answered here rather than run: reading spends
   * against a model, and what this checks is what the host asks of it and
   * what it does with the answer.
   */
  function canned(
    reply: unknown | ((args: string[]) => unknown) = verdict([finding]),
    startProcess?: typeof startLineProcess,
    /** Every other command; the bundled CLI where none is given. */
    otherwise: typeof runProcess = runProcess,
  ) {
    const drifts: string[][] = [];
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "drift") {
        // Up to the `--repo` every command carries, which is the fixture's.
        const asked = args.slice(1, args.indexOf("--repo"));
        drifts.push(asked);
        // Awaited, so a reply can be held back: a reading that takes as long
        // as the test needs it to is how what happens meanwhile is tested.
        const answer = await (typeof reply === "function" ? (reply as (args: string[]) => unknown)(asked) : reply);
        return { code: 0, stdout: JSON.stringify(answer), stderr: "", cancelled: false };
      }
      // The loop itself, where a test approves: nothing here runs an executor.
      if (args[1] === "run") return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      return otherwise(binary, args, options);
    };
    return { ...fixture(runner, startProcess), drifts };
  }
  /** A second place the two have parted, for a reading that finds more than one. */
  const second = {
    heading: "Criterion 2 and R2",
    difference: "R2 asks for a retry; criterion 2 promises none.",
    options: [
      { label: "Add a retry to criterion 2.", detail: null, recommended: true },
      { label: "Drop R2 from the spec.", detail: null, recommended: false },
    ],
  };
  /**
   * An interview that answers every turn with a line and ends it, in place of
   * the CLI's: what is under test is what the host does once a turn is over
   * with problems open, and the fake's whole job is to end one.
   */
  function fakeAnswering(root: string): typeof startLineProcess {
    const binary = join(root, "fake-answering.cjs");
    writeFileSync(
      binary,
      String.raw`
const readline = require('node:readline');
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
send({ type: 'started', session_id: 'sdk-session-2', spec: 'specs/retry-on-failure/spec.md',
  adr: 'docs/adr', model: null, tools: [] });
readline.createInterface({ input: process.stdin })
  .on('line', (line) => {
    const turn = JSON.parse(line);
    // A turn that never ends, for a test that stops the chat in the middle of one.
    if (turn.text === 'Change R1 in the spec to ask for two emails.') return;
    send({ type: 'message', message: { type: 'assistant', session_id: 'sdk-session-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You said: ' + turn.text }] } } });
    if (turn.text === 'ask me')
      send({ type: 'asked', groups: [{ title: 'Its own question', parts: [{ question: 'Which way?',
        options: [{ label: 'This way', detail: null, recommended: true },
                  { label: 'That way', detail: null, recommended: false }] }] }] });
    send({ type: 'idle', turns: 1 });
  })
  .on('close', () => { send({ type: 'ended', session_id: 'sdk-session-2', reason: 'the session ended' }); });
`,
      { mode: 0o700 },
    );
    return (spawned, args, options) =>
      startLineProcess(
        spawned,
        args[1] === "interview" ? [binary, ...args.slice(1)] : [...args],
        options,
      );
  }
  /** The session, once the turn it owes the person is over. */
  async function settled(service: DesktopService, id: string): Promise<void> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if (!((await service.snapshot()).working ?? []).includes(id)) return;
      await delay(10);
    }
    throw new Error("The interview never finished its turn");
  }
  /** Every drift job the host has started, once none is still running. */
  async function driftJobs(service: DesktopService, count: number): Promise<Job[]> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const jobs = (await service.snapshot()).jobs.filter((job) => job.kind === "drift");
      if (jobs.length >= count && jobs.every((job) => !["running", "stopping"].includes(job.state)))
        return jobs;
      await delay(20);
    }
    throw new Error("The plan was not read again");
  }
  /** A planning over PRB-1, admitted the way the board admits one, with a spec beside it. */
  async function planned(service: DesktopService, repoId: string): Promise<string> {
    await finished(service, (await service.request({ kind: "admit", repoId, draft })).id);
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId, key: "PRB-1" },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: session.id,
      repoId,
      title: "Retry on failure",
      sections: {
        outcome: "The user can retry.",
        requirements: "- The user can retry.",
        no_gos: "",
        rabbit_holes: "",
        notes: "",
      },
    });
    return session.id;
  }
  /** A planning over PRB-1 beside the answering interview, its readings replying from `replies` in turn. */
  async function answering() {
    const root = scratchDirectory("perbo-drift-");
    const replies: unknown[] = [];
    const made = canned(() => replies.shift(), fakeAnswering(root));
    const registered = await made.service.registerRepository(made.repo);
    return { ...made, replies, id: await planned(made.service, registered.id) };
  }

  it("runs drift on the ticket's own models and lands the verdict on the job", async () => {
    const { service, repo, drifts } = canned();
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await service.request({
      kind: "taskModels",
      repoId: registered.id,
      key: "PRB-1",
      models: {
        executorProvider: "codex-cli",
        executorModel: "gpt-6-astra",
        executorEffort: null,
        reviewerProvider: "anthropic",
        reviewerModel: "claude-opus-5",
        reviewerEffort: null,
        draftingProvider: "codex-cli",
        executorSkills: [],
      },
    });
    const job = await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect(job.state).toBe("completed");
    expect(job.kind).toBe("drift");
    expect(job.label).toBe("Read the plan against the spec");
    expect(lane(job.kind)).toBe("planning");
    expect(drifts).toEqual([
      ["drift", "PRB-1", "--provider", "codex-cli", "--model", "gpt-6-astra", "--json"],
    ]);
    expect(job.result).toEqual(verdict([finding]));
  });

  it("records the state the asker read at once the reading lands of it, and nothing for an asker with none (D-NEW-basic-and-epic-flows)", async () => {
    const { service, repo } = canned();
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const listed = async () => (await service.snapshot()).drafts?.find((draft) => draft.id === id)?.read;
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect((await service.request({ kind: "editingRead", id })).read).toBeNull();
    await finished(service, (await service.request({ kind: "driftCheck", id, state: "0123456789abcdef" })).id);
    expect((await service.request({ kind: "editingRead", id })).read).toBe("0123456789abcdef");
    expect(await listed()).toBe("0123456789abcdef");
  });

  it("falls back to the settings' models, and fails the job on a print that is not a verdict", async () => {
    const { service, repo, drifts } = canned({ findings: "not a verdict" });
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const settings = (await service.snapshot()).settings;
    const job = await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect(drifts[0]).toEqual([
      "drift", "PRB-1", "--provider", settings.draftingProvider, "--model", settings.executorModel, "--json",
    ]);
    expect(job.state).toBe("failed");
  });

  it("refuses to read before there is a spec, before there is a plan, and once the plan is approved", async () => {
    const { service, repo, drifts } = canned();
    const registered = await service.registerRepository(repo);
    // A plan and no spec.
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const bare = await service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId: registered.id, key: "PRB-1" },
    });
    await expect(service.request({ kind: "driftCheck", id: bare.id, state: null })).rejects.toThrow(
      "Write the spec before reading it against the plan.",
    );
    // A spec and no plan.
    const fresh = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    await saveSpec(service, {
      kind: "specSave",
      id: fresh.id,
      repoId: registered.id,
      title: "Retry on failure",
      sections: { outcome: "The user can retry.", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
    });
    await expect(service.request({ kind: "driftCheck", id: fresh.id, state: null })).rejects.toThrow(
      "Draft a plan from the spec before reading the two against each other.",
    );
    // Both, and approved on disk, which is what the guard reads.
    await saveSpec(service, {
      kind: "specSave",
      id: bare.id,
      repoId: registered.id,
      title: "Retry again",
      sections: { outcome: "The user can retry.", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
    });
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
    writeFileSync(at, JSON.stringify({ ...ticket, approved_at: new Date().toISOString() }));
    await expect(service.request({ kind: "driftCheck", id: bare.id, state: null })).rejects.toThrow(
      /PRB-1 is approved, and what it promises was settled with it/,
    );
    await expect(service.request({ kind: "driftDismiss", id: bare.id })).rejects.toThrow(
      /PRB-1 is approved/,
    );
    // None of them reached the CLI.
    expect(drifts).toEqual([]);
  });

  it("dismisses through the CLI, directly and not as a job", async () => {
    const { service, repo, drifts } = canned(verdict([finding], true));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const before = (await service.snapshot()).jobs.length;
    expect(await service.request({ kind: "driftDismiss", id })).toBeNull();
    expect(drifts).toEqual([["drift", "PRB-1", "--dismiss", "--json"]]);
    expect((await service.snapshot()).jobs).toHaveLength(before);
  });

  it("redacts what the model said before it lands on the job, and fails a reading redaction empties", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const quoted = {
      ...finding,
      heading: "  Criterion 1\n and R1 ",
      difference: `R1 quotes the key ${secret}; criterion 1 does not.`,
      options: [
        { ...finding.options[0], detail: `Drop ${secret} from the spec.` },
        finding.options[1],
      ],
    };
    const { service, repo } = canned(verdict([quoted]));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const job = await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect(job.state).toBe("completed");
    const landed = job.result as { findings: typeof finding[] };
    expect(landed.findings[0]?.heading).toBe("Criterion 1 and R1");
    expect(landed.findings[0]?.difference).toBe("R1 quotes the key [redacted]; criterion 1 does not.");
    expect(landed.findings[0]?.options[0]?.detail).toBe("Drop [redacted] from the spec.");
    expect(JSON.stringify(job.result)).not.toContain(secret);
    // A heading that was nothing but escape codes is no heading: the reading
    // fails rather than putting a card about nothing to the person.
    const blank = canned(verdict([{ ...finding, heading: "[31m[0m" }]));
    const other = await blank.service.registerRepository(blank.repo);
    const at = await planned(blank.service, other.id);
    const failed = await finished(
      blank.service,
      (await blank.service.request({ kind: "driftCheck", id: at, state: null })).id,
    );
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/heading did not survive redaction/);
  });

  it("records the problems on the planning as the reading lands, and puts the first as a question", async () => {
    const { service, repo } = canned(verdict([finding, second]));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const before = (await service.request({ kind: "editingRead", id })).conversation.length;
    const job = await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect(job.state).toBe("completed");
    const session = await service.request({ kind: "editingRead", id });
    // Both on the session, oldest first, and open.
    expect(session.drift).toEqual({ open: [finding, second], resolved: false });
    // The rail's list says so too, by count.
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === id)?.drift).toEqual({
      open: 2,
      resolved: false,
    });
    // And the first is the question in front of the person: one group, its
    // heading as the title, the difference as the question, the ways to close
    // it as the answers, headed as which of how many.
    expect(session.conversation).toHaveLength(before + 1);
    const line = session.conversation.at(-1)!;
    expect(line.line).toEqual({
      kind: "asked",
      groups: [
        {
          title: finding.heading,
          parts: [{ question: finding.difference, options: finding.options }],
        },
      ],
      drift: { open: 2 },
    });
    expect(session.asking).toEqual({ entry: line.n, answered: 0 });
  });

  it("puts nothing twice when a reading finds the same problems again, and records the next when they change", async () => {
    let reply: unknown = verdict([finding, second]);
    const { service, repo } = canned(() => reply);
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    const asked = (lines: { line: { kind: string } }[]) => lines.filter((entry) => entry.line.kind === "asked");
    let session = await service.request({ kind: "editingRead", id });
    expect(asked(session.conversation)).toHaveLength(1);
    expect(session.drift?.open).toHaveLength(2);
    // The first resolved: the second is what is open, and it is put.
    reply = verdict([second]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [second], resolved: false });
    const lines = asked(session.conversation);
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)!.line).toMatchObject({
      groups: [{ title: second.heading }],
      drift: { open: 1 },
    });
  });

  it("records resolved once a reading finds none after some, and says so", async () => {
    let reply: unknown = verdict([finding]);
    const { service, repo } = canned(() => reply);
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    // None where none were ever open is nothing to record: no pane, no note.
    reply = verdict([]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    let session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toBeNull();
    expect(resolvedNotes(session.conversation)).toEqual([]);
    reply = verdict([finding]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    reply = verdict([]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [], resolved: true });
    expect(session.conversation.at(-1)!.line).toEqual({
      kind: "note",
      text: "Every problem is resolved: the plan and the spec promise the same thing again.",
      notable: true,
    });
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === id)?.drift).toEqual({
      open: 0,
      resolved: true,
    });
  });

  it("reads the plan again once a turn ends with problems open, and not while none are", async () => {
    const root = scratchDirectory("perbo-drift-");
    const { service, repo, drifts } = canned(verdict([finding]), fakeAnswering(root));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    // A turn with nothing open asks for no reading.
    await service.request({ kind: "interviewTurn", id, text: "why one criterion?" });
    await settled(service, id);
    expect(drifts).toEqual([]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect(drifts).toHaveLength(1);
    // The answer to the problem in hand, as a card sends it: once the interview
    // has finished the turn, the plan is read against the spec again.
    await service.request({ kind: "interviewTurn", id, text: finding.options[0]!.label });
    await settled(service, id);
    const jobs = await driftJobs(service, 2);
    expect(jobs.map((job) => job.state)).toEqual(["completed", "completed"]);
    expect(drifts).toHaveLength(2);
    await service.request({ kind: "interviewStop", id });
  });

  it("forgets the problems when the person goes on past them, and when the plan is approved", async () => {
    const { service, repo } = canned(verdict([finding]));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect((await service.request({ kind: "editingRead", id })).drift?.open).toHaveLength(1);
    await service.request({ kind: "driftDismiss", id });
    expect((await service.request({ kind: "editingRead", id })).drift).toBeNull();
    // Open again, then approved: what the plan promises is settled with it.
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect((await service.request({ kind: "editingRead", id })).drift?.open).toHaveLength(1);
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
    expect((await service.request({ kind: "editingRead", id })).drift).toBeNull();
  });

  /** The problems put to the person so far: the asked lines that are the host's. */
  const problemsPut = <T extends { line: { kind: string; drift?: unknown } }>(lines: T[]) =>
    lines.filter((entry) => entry.line.kind === "asked" && entry.line.drift !== undefined);
  /** The notes saying every problem is resolved: one per round resolved, and never two for one. */
  const resolvedNotes = (lines: { line: { kind: string; text?: string } }[]) =>
    lines.filter((entry) => entry.line.kind === "note" && entry.line.text === EVERY_PROBLEM_RESOLVED);
  /** A reply held back until the test lets it go. */
  function held<T>() {
    let release!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      release = done;
    });
    return { promise, release };
  }

  it("reads again after a resolved round, and problems found then re-open the record", async () => {
    const root = scratchDirectory("perbo-drift-");
    let reply: unknown = verdict([finding]);
    const { service, repo, drifts } = canned(() => reply, fakeAnswering(root));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    // The answer closes it: the round is resolved.
    reply = verdict([]);
    await service.request({ kind: "interviewTurn", id, text: finding.options[0]!.label });
    await settled(service, id);
    await driftJobs(service, 2);
    let session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [], resolved: true });
    // A turn after that — a hand rewording, say, told to the interview — is
    // read again all the same: the record is resolved, and a resolved record
    // is exactly what cannot know about an edit since.
    reply = verdict([second]);
    await service.request({ kind: "interviewTurn", id, text: "reword criterion 2 to promise a retry" });
    await settled(service, id);
    const jobs = await driftJobs(service, 3);
    expect(jobs.map((job) => job.state)).toEqual(["completed", "completed", "completed"]);
    expect(drifts).toHaveLength(3);
    session = await service.request({ kind: "editingRead", id });
    // Re-opened, and the problem put, as on a first reading.
    expect(session.drift).toEqual({ open: [second], resolved: false });
    expect(problemsPut(session.conversation).at(-1)!.line).toMatchObject({
      groups: [{ title: second.heading }],
      drift: { open: 1 },
    });
    expect(session.asking).not.toBeNull();
    // And the rail's list lands the ticket on its plan while resolved, and on
    // the problems while open: it carries both.
    expect((await service.request({ kind: "drafts" })).find((draft) => draft.id === id)?.drift).toEqual({
      open: 1,
      resolved: false,
    });
    await service.request({ kind: "interviewStop", id });
  });

  it("puts the problem again when the answer did not close it and no card stands, and not over a card", async () => {
    const root = scratchDirectory("perbo-drift-");
    const { service, repo } = canned(verdict([finding]), fakeAnswering(root));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    let session = await service.request({ kind: "editingRead", id });
    expect(problemsPut(session.conversation)).toHaveLength(1);
    expect(session.asking).not.toBeNull();
    // Words of the person's own that are not one of the ways to close it take
    // the card down; the reading finds the problem still there, and with no
    // card standing to answer again, it is put again.
    await service.request({ kind: "interviewTurn", id, text: "Leave criterion 1 as it is for now." });
    await settled(service, id);
    await driftJobs(service, 2);
    session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [finding], resolved: false });
    expect(problemsPut(session.conversation)).toHaveLength(2);
    expect(session.asking).toEqual({ entry: session.conversation.at(-1)!.n, answered: 0 });
    // Over a card that stands, the same reading puts nothing: the card is
    // already there to answer.
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    session = await service.request({ kind: "editingRead", id });
    expect(problemsPut(session.conversation)).toHaveLength(2);
    await service.request({ kind: "interviewStop", id });
  });

  it("takes a problem's card down when a clean reading finds it closed by hand, and says every problem is resolved", async () => {
    let reply: unknown = verdict([finding]);
    const { service, repo } = canned(() => reply);
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    let session = await service.request({ kind: "editingRead", id });
    expect(session.asking).not.toBeNull();
    // Fixed on the Graph pane rather than answered: the card still stands,
    // since nothing has read the plan again yet.
    expect(await finished(service, (await service.request({
      kind: "graphEdit", repoId: registered.id, key: "PRB-1",
      edit: {
        op: "set_criterion", id: "ac_1", text: "The user can retry, once",
        expected_verification: { kind: "test", assertion: "The retry button is visible after failure" },
      },
    })).id)).toMatchObject({ state: "completed", error: null });
    session = await service.request({ kind: "editingRead", id });
    expect(session.asking).not.toBeNull();
    // The reading on arrival finds nothing: the card comes down with the
    // problems, and the note says so, rather than a card standing over a
    // problem that is gone and holding the way on back for it.
    reply = verdict([]);
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    session = await service.request({ kind: "editingRead", id });
    expect(session.asking).toBeNull();
    expect(session.drift).toEqual({ open: [], resolved: true });
    expect(resolvedNotes(session.conversation)).toHaveLength(1);
  });

  it("holds a changed list behind a question the interview is asking of its own", async () => {
    const { service, replies, id } = await answering();
    const second = { ...finding, heading: "Criterion 2 and R2", difference: "R2 asks for a log; criterion 2 does not." };
    replies.push(verdict([finding, second]));
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    // The person's own words, which the interview answers with a question of
    // its own: that question now stands, waiting on them. The reading the
    // turn owes finds the list changed.
    replies.push(verdict([second]));
    await service.request({ kind: "interviewTurn", id, text: "ask me" });
    await settled(service, id);
    let session = await service.request({ kind: "editingRead", id });
    const own = session.conversation.find(
      (entry) => entry.line.kind === "asked" && entry.line.drift === undefined,
    )!;
    expect(own).toBeDefined();
    expect(session.asking).toEqual({ entry: own.n, answered: 0 });
    // The changed list is recorded, and not put over the interview's
    // question, which would be answered as if it were that question.
    await driftJobs(service, 2);
    session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [second], resolved: false });
    expect(problemsPut(session.conversation)).toHaveLength(1);
    expect(session.asking).toEqual({ entry: own.n, answered: 0 });
    // Answered, the reading after puts the problem the record holds.
    replies.push(verdict([second]));
    await service.request({ kind: "interviewTurn", id, text: "This way" });
    await settled(service, id);
    await driftJobs(service, 3);
    session = await service.request({ kind: "editingRead", id });
    expect(problemsPut(session.conversation)).toHaveLength(2);
    expect(problemsPut(session.conversation).at(-1)!.line).toMatchObject({
      groups: [{ title: "Criterion 2 and R2" }],
      drift: { open: 1 },
    });
    await service.request({ kind: "interviewStop", id });
  });

  it("owes one reading to the turns that end while a reading is live, and says resolved once", async () => {
    const { service, replies, id, drifts } = await answering();
    replies.push(verdict([finding]));
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    // A reading that takes as long as two turns.
    const slow = held<unknown>();
    replies.push(slow.promise);
    const live = await service.request({ kind: "driftCheck", id, state: null });
    await service.request({ kind: "interviewTurn", id, text: finding.options[0]!.label });
    await settled(service, id);
    await service.request({ kind: "interviewTurn", id, text: "and make sure the retry is logged" });
    await settled(service, id);
    // Neither turn started a reading over the live one.
    expect(drifts).toHaveLength(2);
    expect((await service.snapshot()).jobs.filter((job) => job.kind === "drift" && isLive(job))).toEqual([
      expect.objectContaining({ id: live.id }),
    ]);
    // It lands, and the one reading the two turns are owed between them
    // follows it: the plan is read as it stands now, and once is enough.
    replies.push(verdict([]));
    slow.release(verdict([finding]));
    const jobs = await driftJobs(service, 3);
    expect(jobs.map((job) => job.state)).toEqual(["completed", "completed", "completed"]);
    await delay(100);
    expect(drifts).toHaveLength(3);
    let session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [], resolved: true });
    expect(resolvedNotes(session.conversation)).toHaveLength(1);
    // A clean reading after a resolved one is nothing new: no second note.
    replies.push(verdict([]));
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    session = await service.request({ kind: "editingRead", id });
    expect(resolvedNotes(session.conversation)).toHaveLength(1);
    await service.request({ kind: "interviewStop", id });
  });

  describe("a reading an interview turn overlapped", () => {
    it("puts nothing back that the turn was answering, and leaves the reading the turn owes to decide", async () => {
      const { service, replies, id } = await answering();
      replies.push(verdict([finding]));
      await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
      // The Problems page's reading on arrival, read before the answer below
      // reached the plan and landing after it: it still finds the problem.
      const slow = held<unknown>();
      replies.push(slow.promise);
      const live = await service.request({ kind: "driftCheck", id, state: null });
      await service.request({ kind: "interviewTurn", id, text: finding.options[0]!.label });
      await settled(service, id);
      let session = await service.request({ kind: "editingRead", id });
      expect(session.asking).toBeNull();
      // The reading the turn owes follows it, and finds the plan as the answer left it.
      const owed = held<unknown>();
      replies.push(owed.promise);
      slow.release(verdict([finding]));
      await finished(service, live.id);
      session = await service.request({ kind: "editingRead", id });
      expect(problemsPut(session.conversation)).toHaveLength(1);
      expect(session.asking).toBeNull();
      owed.release(verdict([]));
      await driftJobs(service, 3);
      session = await service.request({ kind: "editingRead", id });
      expect(session.drift).toEqual({ open: [], resolved: true });
      expect(problemsPut(session.conversation)).toHaveLength(1);
      await service.request({ kind: "interviewStop", id });
    });

    it("reads again as it settles where the turn it overlapped had already ended", async () => {
      const { service, replies, id } = await answering();
      // The Problems page's first reading, held while a turn is sent and
      // ends: with no record yet, the turn's end has nothing to read again.
      const slow = held<unknown>();
      replies.push(slow.promise);
      const live = await service.request({ kind: "driftCheck", id, state: null });
      await service.request({ kind: "interviewTurn", id, text: "make the retry wait a second" });
      await settled(service, id);
      // It lands with a problem, recorded and not put, and the reading its
      // settling owes puts it, once.
      replies.push(verdict([finding]));
      slow.release(verdict([finding]));
      await finished(service, live.id);
      await driftJobs(service, 2);
      const session = await service.request({ kind: "editingRead", id });
      expect(session.drift).toEqual({ open: [finding], resolved: false });
      expect(problemsPut(session.conversation)).toHaveLength(1);
      expect(session.asking).toEqual({ entry: problemsPut(session.conversation)[0]!.n, answered: 0 });
      await service.request({ kind: "interviewStop", id });
    });
  });

  it("reads again when the chat is stopped in the middle of the turn that answered a card", async () => {
    const { service, replies, id } = await answering();
    replies.push(verdict([finding, second]));
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    // The card is answered, and the turn answering it never ends.
    await service.request({ kind: "interviewTurn", id, text: finding.options[1]!.label });
    let session = await service.request({ kind: "editingRead", id });
    expect(session.asking).toBeNull();
    expect((await service.snapshot()).working).toContain(id);
    // Stopped, the turn is over and the reading it owed runs: the next card.
    replies.push(verdict([second]), verdict([second]));
    await service.request({ kind: "interviewStop", id });
    await driftJobs(service, 2);
    await delay(100);
    await driftJobs(service, 2);
    session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toEqual({ open: [second], resolved: false });
    expect(problemsPut(session.conversation)).toHaveLength(2);
    expect(problemsPut(session.conversation).at(-1)!.line).toMatchObject({
      groups: [{ title: "Criterion 2 and R2" }],
    });
    expect(session.asking).toEqual({ entry: problemsPut(session.conversation).at(-1)!.n, answered: 0 });
  });

  it("records nothing from a reading that lands after the plan was approved or gone past", async () => {
    // Approved on disk while the model read, as another process approves.
    const slow = held<unknown>();
    const { service, repo } = canned((args: string[]) => (args.includes("--dismiss") ? verdict([finding], true) : slow.promise));
    const registered = await service.registerRepository(repo);
    const id = await planned(service, registered.id);
    const live = await service.request({ kind: "driftCheck", id, state: null });
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
    writeFileSync(at, JSON.stringify({ ...ticket, approved_at: new Date().toISOString() }));
    slow.release(verdict([finding]));
    expect((await finished(service, live.id)).state).toBe("completed");
    let session = await service.request({ kind: "editingRead", id });
    expect(session.drift).toBeNull();
    expect(problemsPut(session.conversation)).toHaveLength(0);
    // Gone past while the model read: the person went on to the contract.
    const again = held<unknown>();
    const other = canned((args: string[]) => (args.includes("--dismiss") ? verdict([finding], true) : again.promise));
    const elsewhere = await other.service.registerRepository(other.repo);
    const past = await planned(other.service, elsewhere.id);
    const reading = await other.service.request({ kind: "driftCheck", id: past, state: null });
    await other.service.request({ kind: "driftDismiss", id: past });
    again.release(verdict([finding]));
    expect((await finished(other.service, reading.id)).state).toBe("completed");
    session = await other.service.request({ kind: "editingRead", id: past });
    expect(session.drift).toBeNull();
    expect(problemsPut(session.conversation)).toHaveLength(0);
  });

  it("deletes the verdict with the rest of the ticket's records", async () => {
    const { service, repo } = canned();
    const registered = await service.registerRepository(repo);
    await planned(service, registered.id);
    const record = join(repo, ".perbo", "tickets", "PRB-1.drift.json");
    writeFileSync(record, JSON.stringify({ ...verdict([]), key: undefined, cached: undefined }));
    expect(existsSync(record)).toBe(true);
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(repo, ".perbo", "tickets", "PRB-1.json"))).toBe(false);
  });

  /** The chat started beside a planning, once its own `started` event has reached the record. */
  async function chatting(service: DesktopService, repoId: string, id: string): Promise<void> {
    await service.request({ kind: "interviewStart", repoId, id });
    for (let count = 0; count < 400; count++) {
      if ((await service.request({ kind: "editingRead", id })).interviewSession !== null) return;
      await delay(10);
    }
    throw new Error("The interview never reported a session");
  }
  /**
   * Once the chat has gone and no command is running, and a moment after: a
   * reading its stop or its exit started has started by then.
   */
  async function quiet(service: DesktopService, id: string): Promise<void> {
    const until = Date.now() + 20_000;
    for (;;) {
      const snapshot = await service.snapshot();
      if (!(snapshot.interviews ?? []).includes(id) && !snapshot.jobs.some(isLive)) break;
      if (Date.now() > until)
        throw new Error(
          `The chat never went, or a command never settled: ${snapshot.jobs
            .filter(isLive)
            .map((job) => job.kind)
            .join(", ")}`,
        );
      await delay(20);
    }
    await delay(300);
  }
  /** The chat's notes that a reading could not be started. */
  const unstarted = (session: { conversation: InterviewEntry[] }): InterviewEntry[] =>
    session.conversation.filter(
      (entry) => entry.line.kind === "note" && entry.line.text.startsWith(REREAD_COULD_NOT_START),
    );
  const retrying = {
    outcome: "The user can retry.",
    requirements: "- The user can retry.",
    no_gos: "",
    rabbit_holes: "",
    notes: "",
  };

  /**
   * A planning that drafted PRB-1 from its spec, with a reading that found a
   * problem and its chat running: work its own discard deletes whole. Every
   * reading after the first is held until `later` is released.
   */
  async function draftedWithProblems() {
    const root = scratchDirectory("perbo-drift-");
    let repo = "";
    const later = held<unknown>();
    let reads = 0;
    const made = canned(
      () => (reads++ === 0 ? verdict([finding]) : later.promise),
      fakeAnswering(root),
      drafting(() => repo),
    );
    repo = made.repo;
    const { service, drifts } = made;
    const repoId = (await service.registerRepository(repo)).id;
    const { id } = await service.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    await saveSpec(service, { kind: "specSave", id, repoId, title: "Retry on failure", sections: retrying });
    const before = await service.request({ kind: "editingRead", id });
    const submitted = await service.request({
      kind: "editingSubmit",
      id,
      revision: before.revision,
      operationId: randomUUID(),
      intent: "generate",
    });
    await finished(service, submitted.operation!.jobId!);
    let session = await service.request({ kind: "editingRead", id });
    for (let tries = 0; tries < 400 && session.key === null; tries += 1) {
      await delay(10);
      session = await service.request({ kind: "editingRead", id });
    }
    expect(session, "the ticket this planning drafted").toMatchObject({ key: "PRB-1", admitted: true });
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect((await service.request({ kind: "editingRead", id })).drift, "a reading that found a problem").not.toBeNull();
    await chatting(service, repoId, id);
    return {
      service,
      repo,
      repoId,
      id,
      drifts,
      later,
      ticket: join(repo, ".perbo", "tickets", "PRB-1.json"),
      spec: join(repo, "specs", "retry-on-failure"),
    };
  }

  it("reads nothing again as a planning with problems open is thrown away, and deletes its work whole", async () => {
    // Throwing the planning away stops its chat, and the stop and the chat's
    // exit each end a turn. A reading started there holds the repository as
    // the delete of its ticket checks, which left the ticket and the spec
    // behind (D-129), and reads files the delete is removing.
    const made = await draftedWithProblems();
    try {
      await made.service.request({ kind: "editingDiscard", id: made.id });
      await quiet(made.service, made.id);
      expect(existsSync(made.ticket), "the ticket").toBe(false);
      expect(existsSync(made.spec), "the spec").toBe(false);
      expect(made.drifts, "the one reading the pane asked for").toHaveLength(1);
      expect((await made.service.snapshot()).jobs.filter((job) => job.kind === "drift")).toHaveLength(1);
      expect(unstarted(await made.service.request({ kind: "editingRead", id: made.id })), "nor tried to").toEqual([]);
      // And none is started for it on request: its plan went with it.
      await expect(made.service.request({ kind: "driftCheck", id: made.id, state: null })).rejects.toThrow(
        "This planning has been thrown away",
      );
    } finally {
      made.later.release(verdict([finding]));
    }
  });

  it("refuses to throw a planning away while a reading of its plan is running, and says why", async () => {
    // The reading holds the repository, so the ticket this planning drafted
    // cannot be deleted with it. Refused before anything goes, so the person
    // finds the work as it was, and the reason (D-129).
    const made = await draftedWithProblems();
    try {
      await made.service.request({ kind: "driftCheck", id: made.id, state: null });
      await expect(made.service.request({ kind: "editingDiscard", id: made.id })).rejects.toThrow(
        DELETE_WAITS_FOR_COMMANDS,
      );
      expect((await made.service.request({ kind: "editingRead", id: made.id })).phase).not.toBe("discarded");
      expect(existsSync(made.ticket), "the ticket").toBe(true);
      expect(existsSync(made.spec), "the spec").toBe(true);
      expect((await made.service.snapshot()).interviews ?? [], "the chat").toContain(made.id);
    } finally {
      made.later.release(verdict([finding]));
    }
    await made.service.request({ kind: "interviewStop", id: made.id });
  });

  it("takes the spec folder with a planning thrown away after its ticket was deleted out of band", async () => {
    // A ticket already gone names the folder no more than one the delete took,
    // so the folder goes with the planning (D-129).
    const made = await draftedWithProblems();
    try {
      rmSync(made.ticket);
      await made.service.request({ kind: "editingDiscard", id: made.id });
      expect((await made.service.request({ kind: "editingRead", id: made.id })).phase).toBe("discarded");
      expect(existsSync(made.spec), "the spec folder").toBe(false);
    } finally {
      made.later.release(verdict([finding]));
    }
  });

  it("says why a planning's ticket stays where it is thrown away over an open pull request", async () => {
    // The one stage a delete does not reach (D-129): the planning goes, and
    // the person is told why the work did not go with it.
    const made = await draftedWithProblems();
    try {
      const record = JSON.parse(readFileSync(made.ticket, "utf8")) as Record<string, unknown>;
      writeFileSync(made.ticket, JSON.stringify({ ...record, state: "pr_open" }));
      await expect(made.service.request({ kind: "editingDiscard", id: made.id })).rejects.toThrow(
        "PRB-1 has a pull request open",
      );
      expect(existsSync(made.ticket), "the ticket").toBe(true);
      expect(existsSync(made.spec), "the spec its plan is read against").toBe(true);
    } finally {
      made.later.release(verdict([finding]));
    }
  });

  it("reads nothing again as work with problems open is deleted from its contract, and leaves no verdict behind", async () => {
    // The delete stops the chat of the planning over the ticket, and a reading
    // started by that stop or by the chat's exit runs `perbo drift` while the
    // files are removed, writing its verdict back beside a ticket that has gone.
    const root = scratchDirectory("perbo-drift-");
    let repo = "";
    // What `perbo drift` leaves as it reads: its verdict beside the ticket.
    const made = canned(() => {
      writeFileSync(join(repo, ".perbo", "tickets", "PRB-1.drift.json"), JSON.stringify(verdict([finding])));
      return verdict([finding]);
    }, fakeAnswering(root));
    repo = made.repo;
    const { service, drifts } = made;
    const repoId = (await service.registerRepository(repo)).id;
    const id = await planned(service, repoId);
    // Drafted from the spec the planning writes, as `admit --from-spec`
    // records it, so the spec goes with the ticket.
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as { admission: { spec?: unknown } };
    ticket.admission.spec = {
      path: "specs/retry-on-failure/spec.md",
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(at, JSON.stringify(ticket));
    await finished(service, (await service.request({ kind: "driftCheck", id, state: null })).id);
    expect((await service.request({ kind: "editingRead", id })).drift, "a reading that found a problem").not.toBeNull();
    await chatting(service, repoId, id);

    await service.request({ kind: "discard", repoId, key: "PRB-1" });
    await quiet(service, id);
    expect(existsSync(at), "the ticket").toBe(false);
    expect(existsSync(join(repo, ".perbo", "tickets", "PRB-1.drift.json")), "the verdict").toBe(false);
    expect(existsSync(join(repo, "specs", "retry-on-failure")), "the spec").toBe(false);
    expect(drifts, "the one reading the pane asked for").toHaveLength(1);
    expect((await service.snapshot()).jobs.filter((job) => job.kind === "drift")).toHaveLength(1);
    expect(unstarted(await service.request({ kind: "editingRead", id })), "nor tried to").toEqual([]);
  });
});

/**
 * A run somebody stopped, and the two things the host does about it.
 *
 * The approved contract is frozen (ADR-0016), so there is no editing a stopped
 * plan back into shape: the work is planned again from the spec it was drafted
 * from, which mints a second ticket beside the stopped one, or it is deleted
 * whole (D-129).
 */
describe("a stopped run's ticket", () => {
  const slug = "retire-the-legacy-csv-importer";
  const spec = `specs/${slug}/spec.md`;
  /** The records a stop leaves: a spent ticket, its attempt, and the bundle that attempt sealed. */
  const chosen = {
    executorProvider: "codex-cli" as const,
    executorModel: "gpt-6-astra",
    executorEffort: null,
    reviewerProvider: "anthropic" as const,
    reviewerModel: "claude-opus-5",
    reviewerEffort: null,
    draftingProvider: "codex-cli" as const,
    executorSkills: [],
  };
  async function stopped(runner?: typeof runProcess) {
    const made = fixture(runner);
    const repoId = (await made.service.registerRepository(made.repo)).id;
    mkdirSync(join(made.repo, "specs", slug), { recursive: true });
    writeFileSync(
      join(made.repo, "specs", slug, "spec.md"),
      "# Retire the legacy CSV importer\n\n## Outcome\n\nEvery import goes through the current " +
        "parser.\n\n## Requirements\n\n- R1: An upload of either dialect is read.\n\n## No-Gos\n" +
        "\n## Rabbit holes\n\n## Notes\n",
    );
    await finished(
      made.service,
      (await made.service.request({ kind: "admit", repoId, draft })).id,
    );
    // Chosen while the contract is still open to it, which is the only time
    // the page offers the choice.
    await made.service.request({ kind: "taskModels", repoId, key: "PRB-1", models: chosen });
    const at = join(made.repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as {
      ticket_id: string;
      state: string;
      approved_at: string | null;
      admission: { spec?: unknown };
    };
    // Where a stop inside the executor's window leaves the record: the attempt
    // sealed, the ticket failed, the contract still approved and frozen.
    ticket.state = "failed";
    ticket.approved_at = "2026-09-08T09:00:00.000Z";
    ticket.admission.spec = {
      path: spec,
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(at, JSON.stringify(ticket));
    const attempts = join(made.repo, ".perbo", "state", `${ticket.ticket_id}.attempts.json`);
    mkdirSync(dirname(attempts), { recursive: true });
    writeFileSync(
      attempts,
      JSON.stringify({
        ticket_id: ticket.ticket_id,
        attempts: [{ attempt_id: "att_1", termination: { reason: "cancelled" } }],
      }),
    );
    const bundles = join(made.repo, ".perbo", "bundles", "bundles");
    mkdirSync(bundles, { recursive: true });
    const mine = join(bundles, "bundle_0000000000000415.json");
    writeFileSync(
      mine,
      JSON.stringify({
        bundle_id: "bundle_0000000000000415",
        kind: "execution",
        subject_id: "att_1",
        ticket_id: ticket.ticket_id,
        artifacts: [],
      }),
    );
    const other = join(bundles, "bundle_0000000000000999.json");
    writeFileSync(
      other,
      JSON.stringify({
        bundle_id: "bundle_0000000000000999",
        kind: "execution",
        subject_id: "att_9",
        ticket_id: "ticket_somebody_else",
        artifacts: [],
      }),
    );
    return { ...made, repoId, at, attempts, mine, other };
  }

  it("deletes the stopped ticket and its evidence, keeps the spec, and opens a planning over the plan drafted from it", async () => {
    // The fixture's repository is not there until the fixture has made it, so
    // the fake is given a way to ask for it rather than the path itself.
    let repo = "";
    const asked: string[][] = [];
    const standing: boolean[] = [];
    const made = await stopped(drafting(() => repo, asked, standing));
    repo = made.repo;

    const opened = await made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" });
    // Drafted on the stopped ticket's own models, and the new plan keeps them:
    // it is the same work, and pressing this is not choosing again.
    expect(asked[0]).toEqual([
      "admit", "--prefix", "PRB", "--from-spec", spec,
      "--provider", "codex-cli", "--model", "gpt-6-astra", "--json",
    ]);
    // Deleted before the admission ran, so the new plan is named as the only
    // plan this spec has.
    expect(standing).toEqual([false]);
    expect((await made.service.snapshot()).taskModels?.[`${made.repoId}:PRB-2`]).toEqual(chosen);
    // A planning over the new plan, with its ticket and the shape it landed in.
    expect(opened.key).toBe("PRB-2");
    expect(opened.nodes).toBeGreaterThanOrEqual(0);
    const session = await made.service.request({ kind: "editingRead", id: opened.sessionId });
    expect(session.key).toBe("PRB-2");
    // The stopped ticket is gone, and everything recorded after its contract
    // with it; another ticket's evidence was never asked about.
    for (const suffix of [".json", ".contract.json", ".draft.json", ".approach.json"])
      expect(existsSync(join(made.repo, ".perbo", "tickets", `PRB-1${suffix}`)), `PRB-1${suffix}`).toBe(false);
    expect(existsSync(made.attempts), "the attempts record").toBe(false);
    expect(existsSync(made.mine), "the bundle that attempt sealed").toBe(false);
    expect(existsSync(made.other), "another ticket's bundle").toBe(true);
    // The spec stays: the new plan was drafted from it.
    expect(existsSync(join(made.repo, spec)), "the spec").toBe(true);
    const snapshot = await made.service.snapshot();
    expect(snapshot.tasks.map((row) => row.ticket.key)).toEqual(["PRB-2"]);
    expect(snapshot.taskModels?.[`${made.repoId}:PRB-1`]).toBeUndefined();
    const minted = JSON.parse(
      readFileSync(join(made.repo, ".perbo", "tickets", "PRB-2.json"), "utf8"),
    ) as { state: string; admission: { spec: { path: string } } };
    expect(minted.state).toBe("plan_review");
    expect(minted.admission.spec.path).toBe(spec);
  });

  it("drafts again under the name the person gave the spec, where the planning that records it is still there (D-127)", async () => {
    let repo = "";
    const asked: string[][] = [];
    const made = await stopped(drafting(() => repo, asked));
    repo = made.repo;
    // The planning over the ticket while it was still being planned, where
    // the person titled its spec: the records as they were then, with no
    // attempt yet.
    const at = join(made.repo, ".perbo", "tickets", "PRB-1.json");
    const spent = readFileSync(at, "utf8");
    const attempts = readFileSync(made.attempts, "utf8");
    rmSync(made.attempts);
    writeFileSync(at, JSON.stringify({ ...JSON.parse(spent), state: "plan_review", approved_at: null }));
    const planning = await made.service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId: made.repoId, key: "PRB-1" },
    });
    const read = await made.service.request({ kind: "specRead", id: planning.id });
    await saveSpec(made.service, {
      kind: "specSave",
      id: planning.id,
      repoId: made.repoId,
      title: "Retire the CSV importer",
      sections: read.sections,
    });
    writeFileSync(at, spent);
    writeFileSync(made.attempts, attempts);

    const opened = await made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" });
    expect(asked[0]).toEqual([
      "admit", "--prefix", "PRB", "--from-spec", spec, "--keep-title",
      "--provider", "codex-cli", "--model", "gpt-6-astra", "--json",
    ]);
    // The planning over the new plan holds who named the spec, so drafting it
    // again from there keeps the person's name too.
    expect((await made.service.request({ kind: "editingRead", id: opened.sessionId })).named).toEqual({
      by: "person",
      title: "Retire the CSV importer",
    });
    await finished(
      made.service,
      (
        await made.service.request({
          kind: "startOver",
          repoId: made.repoId,
          id: opened.sessionId,
          key: "PRB-2",
        })
      ).id,
    );
    expect(asked[1]).toContain("--start-over");
    expect(asked[1]).toContain("--keep-title");
  });

  it("says the stopped ticket is gone when the plan cannot be drafted again, and leaves the spec", async () => {
    const made = await stopped(async (binary, args, options) =>
      args[1] === "admit" && args.includes("--from-spec")
        ? { code: 1, stdout: "", stderr: "the model refused", cancelled: false }
        : runProcess(binary, args, options),
    );
    await expect(
      made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(
      /^PRB-1 was deleted and its plan could not be drafted again: .*the model refused.*\. Its spec is in Create's picker; draft the plan from there\.$/s,
    );
    expect(existsSync(made.at), "the stopped ticket").toBe(false);
    expect(existsSync(join(made.repo, spec)), "the spec").toBe(true);
  });

  it("refuses to plan again a ticket that was not drafted from a spec", async () => {
    const made = await stopped();
    const at = join(made.repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as { admission: { spec: unknown } };
    ticket.admission.spec = null;
    writeFileSync(at, JSON.stringify(ticket));
    await expect(
      made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(/was not drafted from a spec, so there is no spec to start over from/);
  });

  it("deletes a ticket that has run whole: its records, its evidence and its spec", async () => {
    const made = await stopped();
    await made.service.request({ kind: "discard", repoId: made.repoId, key: "PRB-1" });
    for (const suffix of [".json", ".contract.json", ".draft.json", ".approach.json"])
      expect(
        existsSync(join(made.repo, ".perbo", "tickets", `PRB-1${suffix}`)),
        `PRB-1${suffix}`,
      ).toBe(false);
    expect(existsSync(made.attempts), "the attempts record").toBe(false);
    expect(existsSync(made.mine), "the bundle that attempt sealed").toBe(false);
    expect(existsSync(join(made.repo, "specs", slug)), "the spec it was drafted from").toBe(false);
    // Another ticket's evidence was never asked about.
    expect(existsSync(made.other), "another ticket's bundle").toBe(true);
    expect((await made.service.snapshot()).tasks.some((row) => row.ticket.key === "PRB-1")).toBe(
      false,
    );
  });

  it("deletes each bundle by the file it was read from, never by the id that file records", async () => {
    // A repository Perbo materializes is untrusted content (ADR-0030), and a
    // bundle manifest is a file in it: `bundle_id` is whatever the JSON says.
    // Rebuilding the path from that field makes an ordinary delete reach
    // whatever the content names, so the file the listing actually read is the
    // only one deleted.
    const made = await stopped();
    const { ticket_id } = JSON.parse(readFileSync(made.at, "utf8")) as { ticket_id: string };
    const bundles = join(made.repo, ".perbo", "bundles", "bundles");
    const near = join(made.repo, ".perbo", "victim.json");
    const far = join(made.root, "victim.json");
    writeFileSync(near, "{}");
    writeFileSync(far, "{}");
    for (const [name, id] of [
      ["crafted-near.json", "../../victim"],
      ["crafted-far.json", "../../../../victim"],
    ])
      writeFileSync(
        join(bundles, name!),
        JSON.stringify({
          bundle_id: id,
          kind: "execution",
          subject_id: "att_1",
          ticket_id,
          artifacts: [],
        }),
      );

    await made.service.request({ kind: "discard", repoId: made.repoId, key: "PRB-1" });

    expect(existsSync(near), "a file inside the repository the id pointed at").toBe(true);
    expect(existsSync(far), "a file outside the repository the id pointed at").toBe(true);
    for (const name of ["crafted-near.json", "crafted-far.json"])
      expect(existsSync(join(bundles, name)), name).toBe(false);
  });

  it("refuses to delete work whose pull request is open, and deletes it once that is settled", async () => {
    // The one stage a delete does not reach: the pull request is on GitHub, and
    // deleting the ticket would leave it standing with nothing here to read it
    // against (D-129).
    const made = await stopped();
    const held = JSON.parse(readFileSync(made.at, "utf8")) as { state: string };
    writeFileSync(made.at, JSON.stringify({ ...held, state: "pr_open" }));
    await expect(
      made.service.request({ kind: "discard", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(/has a pull request open, and that is a record this machine does not own/);
    expect(existsSync(join(made.repo, ".perbo", "tickets", "PRB-1.json"))).toBe(true);
    expect(existsSync(join(made.repo, "specs", slug))).toBe(true);
    // Merged on GitHub, and the work is the person's to delete again.
    writeFileSync(made.at, JSON.stringify({ ...held, state: "merged" }));
    await made.service.request({ kind: "discard", repoId: made.repoId, key: "PRB-1" });
    expect(existsSync(join(made.repo, ".perbo", "tickets", "PRB-1.json"))).toBe(false);
  });

  it("refuses a stranded ticket in the CLI's own words, before it deletes or spends anything", async () => {
    // A run killed outside the executor's window leaves the ticket saying
    // `executing`, which is still the plan this spec has. The stopped ticket
    // is deleted before the admission runs, so the host asks `admit`'s own
    // question first, in its sentence, and nothing is deleted or started.
    const seen: string[][] = [];
    const made = await stopped(async (binary, args, options) => {
      seen.push(args.slice(1, args.indexOf("--repo")));
      return runProcess(binary, args, options);
    });
    const ticket = JSON.parse(readFileSync(made.at, "utf8")) as { state: string };
    writeFileSync(made.at, JSON.stringify({ ...ticket, state: "executing" }));
    // What the fixture itself ran is not what this test is reading.
    seen.length = 0;

    await expect(
      made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(/PRB-1 was already drafted from specs\/.*, and one spec is one piece of work/);
    expect(seen.some((argv) => argv[0] === "sync" || argv[0] === "admit")).toBe(false);
    // Nothing was deleted: the stranded ticket is the plan this spec has.
    expect((await made.service.snapshot()).tasks.map((row) => row.ticket.key)).toEqual(["PRB-1"]);
    expect(existsSync(made.attempts), "the attempts record").toBe(true);
    expect(existsSync(made.mine), "the bundle that attempt sealed").toBe(true);
  });

  it("refuses to plan again from a spec that is no longer there, before it spends a job", async () => {
    // `admit` says this itself, but only after a job has been started and a
    // model asked. A spec deleted in the person's own editor is the reachable
    // way here, and the answer is the command's own sentence.
    const seen: string[][] = [];
    const made = await stopped(async (binary, args, options) => {
      seen.push(args.slice(1, args.indexOf("--repo")));
      return runProcess(binary, args, options);
    });
    rmSync(join(made.repo, "specs", slug), { recursive: true, force: true });
    seen.length = 0;
    await expect(
      made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(/^no spec at .*specs\/retire-the-legacy-csv-importer\/spec\.md$/);
    expect(seen.some((argv) => argv[0] === "admit"), "an admission was started").toBe(false);
  });

  it("builds the spec it drafts from out of the repository's own spec folder", async () => {
    // `admission.spec.path` is a string read out of a repository file, and the
    // guard written for it is `specSlugOf`: a recorded path whose folder is not
    // this repository's spec folder names a spec this admission has no business
    // reading, whatever the record says.
    const seen: string[][] = [];
    const made = await stopped(async (binary, args, options) => {
      seen.push(args.slice(1, args.indexOf("--repo")));
      return runProcess(binary, args, options);
    });
    const ticket = JSON.parse(readFileSync(made.at, "utf8")) as {
      admission: { spec: { path: string } };
    };
    ticket.admission.spec.path = `../outside/${slug}/spec.md`;
    writeFileSync(made.at, JSON.stringify(ticket));
    seen.length = 0;
    await expect(
      made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
    ).rejects.toThrow(/was not drafted from a spec, so there is no spec to start over from/);
    expect(seen.some((argv) => argv[0] === "admit"), "an admission was started").toBe(false);
  });

  describe("Plan it again where the pull request is open", () => {
    it("is refused before anything is deleted or drafted, because that ticket is not deleted", async () => {
      const seen: string[][] = [];
      const made = await stopped(async (binary, args, options) => {
        seen.push(args.slice(1, args.indexOf("--repo")));
        return runProcess(binary, args, options);
      });
      const held = JSON.parse(readFileSync(made.at, "utf8")) as { state: string };
      writeFileSync(made.at, JSON.stringify({ ...held, state: "pr_open" }));
      seen.length = 0;
      await expect(
        made.service.request({ kind: "replan", repoId: made.repoId, key: "PRB-1" }),
      ).rejects.toThrow(/PRB-1 is pr_open, which is past re-drafting/);
      expect(seen.some((argv) => argv[0] === "admit"), "an admission was started").toBe(false);
      expect(existsSync(made.at), "the ticket").toBe(true);
      expect(existsSync(made.attempts), "the attempts record").toBe(true);
      expect(existsSync(made.mine), "the bundle that attempt sealed").toBe(true);
    });
  });
});

describe("a ticket renamed while it is planned renames its spec (D-127)", () => {
  const SPEC_MD =
    "# a simple snake game that eats apples to grow longer and gets\n\n## Outcome\n\nA snake eats apples and grows.\n";

  const digestOf = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  /** A ticket on the board drafted from `specs/a-simple-snake-game/spec.md`, as `admit --from-spec` records it. */
  async function planned(process?: typeof runProcess, also?: Partial<ServiceOptions>) {
    const { service, repo } = fixture(process, undefined, also);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const specPath = join(repo, "specs", "a-simple-snake-game", "spec.md");
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, SPEC_MD);
    const at = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(at, "utf8")) as { admission: Record<string, unknown> };
    ticket.admission["spec"] = {
      path: "specs/a-simple-snake-game/spec.md",
      content_sha256: digestOf(SPEC_MD),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
    writeFileSync(at, JSON.stringify(ticket, null, 2));
    return { service, repo, repoId: registered.id, specPath };
  }

  it("titles the spec with the new name, the folder and the rest of the file as they were", async () => {
    const changes: Change[] = [];
    const { service, repo, repoId, specPath } = await planned(undefined, { changed: (change) => void changes.push(change) });
    await service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" });

    expect(readFileSync(specPath, "utf8")).toBe(SPEC_MD.replace(/^# .*$/m, "# Snake game"));
    expect(readdirSync(join(repo, "specs"))).toEqual(["a-simple-snake-game"]);
    const snapshot = await service.snapshot();
    expect(snapshot.titles?.[repoId + ":PRB-1"]).toBe("Snake game");
    expect(snapshot.specs?.find((spec) => spec.slug === "a-simple-snake-game")?.title).toBe("Snake game");
    expect(changes).toContainEqual(expect.objectContaining({ kind: "records", repoId, key: "PRB-1" }));
  });

  it("takes the name where the spec file has gone, and writes no spec", async () => {
    const { service, repoId, specPath } = await planned();
    rmSync(specPath);
    await service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" });

    expect(existsSync(specPath)).toBe(false);
    expect((await service.snapshot()).titles?.[repoId + ":PRB-1"]).toBe("Snake game");
  });

  it("refuses the rename whole where the spec cannot be retitled, and the ticket keeps its name", async () => {
    const changes: Change[] = [];
    const { service, repo, repoId, specPath } = await planned(undefined, { changed: (change) => void changes.push(change) });
    // A link at spec.md is a path the host refuses to write through.
    const elsewhere = join(repo, "elsewhere.md");
    writeFileSync(elsewhere, SPEC_MD);
    rmSync(specPath);
    symlinkSync(elsewhere, specPath);
    const before = (await service.snapshot()).titles?.[repoId + ":PRB-1"];
    changes.length = 0;
    await expect(
      service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" }),
    ).rejects.toThrow(/symlink/);

    expect((await service.snapshot()).titles?.[repoId + ":PRB-1"]).toBe(before);
    expect(changes).not.toContainEqual(expect.objectContaining({ kind: "preferences" }));
    expect(readFileSync(elsewhere, "utf8")).toBe(SPEC_MD);
  });

  it("carries the verdict the plan was read against its spec with to the renamed spec", async () => {
    const { service, repo, repoId, specPath } = await planned();
    const at = join(repo, ".perbo", "tickets", "PRB-1.drift.json");
    const record = {
      spec: digestOf(SPEC_MD),
      promises: `sha256:${"1".repeat(64)}`,
      origin: "read",
      findings: [
        {
          heading: "The outcome",
          difference: "The spec says the snake grows, and the plan does not.",
          options: [
            { label: "Make the plan say it grows.", detail: null, recommended: true },
            { label: "Drop growing from the spec.", detail: null, recommended: false },
          ],
        },
      ],
      dismissed: true,
      checked_at: "2026-09-01T00:00:00.000Z",
      model: null,
    };
    writeFileSync(at, JSON.stringify(record, null, 2));
    await service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" });

    expect(JSON.parse(readFileSync(at, "utf8"))).toEqual({ ...record, spec: digestOf(readFileSync(specPath)) });
    expect(digestOf(readFileSync(specPath))).not.toBe(record.spec);
  });

  it("refuses the rename whole where the verdict cannot be carried, and the spec keeps its title", async () => {
    const { service, repo, repoId, specPath } = await planned();
    const at = join(repo, ".perbo", "tickets", "PRB-1.drift.json");
    const record = {
      spec: digestOf(SPEC_MD),
      promises: `sha256:${"1".repeat(64)}`,
      origin: "drafted",
      findings: [],
      dismissed: false,
      checked_at: "2026-09-01T00:00:00.000Z",
      model: null,
    };
    writeFileSync(at, JSON.stringify(record, null, 2));
    // The record reads and cannot be written, so carrying it forward fails.
    chmodSync(at, 0o444);
    const before = (await service.snapshot()).titles?.[repoId + ":PRB-1"];
    try {
      await expect(
        service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" }),
      ).rejects.toThrow();
    } finally {
      chmodSync(at, 0o644);
    }

    expect(readFileSync(specPath, "utf8")).toBe(SPEC_MD);
    expect(JSON.parse(readFileSync(at, "utf8"))).toEqual(record);
    expect((await service.snapshot()).titles?.[repoId + ":PRB-1"]).toBe(before);
  });

  it("keeps the person's name on the spec when the plan is drafted again", async () => {
    // `admit --start-over` titles the spec with the name it drafts, as the
    // CLI's own tests show; this stands in for that write.
    const redraft: typeof runProcess = async (binary, args, options) => {
      if (args[1] !== "admit" || !args.includes("--start-over")) return runProcess(binary, args, options);
      const repo = args[args.indexOf("--repo") + 1]!;
      const specPath = join(repo, "specs", "a-simple-snake-game", "spec.md");
      writeFileSync(specPath, readFileSync(specPath, "utf8").replace(/^# .*$/m, "# Snake that grows"));
      const ticket: unknown = JSON.parse(readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8"));
      return { code: 0, stdout: JSON.stringify({ ticket }), stderr: "", cancelled: false };
    };
    const { service, repoId, specPath } = await planned(redraft);
    await service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" });
    const session = await service.request({
      kind: "editingOpen",
      target: { kind: "planning", repoId, key: "PRB-1" },
    });
    const job = await service.request({ kind: "startOver", repoId, id: session.id, key: "PRB-1" });
    expect((await finished(service, job.id)).state).toBe("completed");

    expect(readFileSync(specPath, "utf8").split("\n")[0]).toBe("# Snake game");
    expect((await service.snapshot()).titles?.[repoId + ":PRB-1"]).toBe("Snake game");
  });

  it("leaves an approved ticket's spec as approval read it", async () => {
    const { service, repo, repoId, specPath } = await planned();
    execFileSync(globalThis.process.execPath, [resolve("../cli/dist/perbo.js"), "approve", "PRB-1", "--repo", repo], {
      stdio: "ignore",
    });
    await service.request({ kind: "rename", repoId, key: "PRB-1", title: "Snake game" });

    expect(readFileSync(specPath, "utf8")).toBe(SPEC_MD);
    expect((await service.snapshot()).titles?.[repoId + ":PRB-1"]).toBe("Snake game");
  });
});

describe("what the host lets a person archive", () => {
  it("files a stopped or finished ticket and refuses one its loop still carries", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "approve") return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      if (args[1] === "run") {
        await held;
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    const archive = (archived: boolean) =>
      service.request({ kind: "archive", repoId: registered.id, keys: ["PRB-1"], archived });
    const refusal = "PRB-1 is still in its loop. Archive it once it has finished or its run has stopped.";
    await expect(archive(true)).rejects.toThrow(refusal);
    const detail = await service.detail(registered.id, "PRB-1");
    const run = await service.request({
      kind: "run",
      repoId: registered.id,
      key: "PRB-1",
      digest: detail.digest,
      approve: true,
      publish: false,
      resumeFrom: null,
    });
    setTicketState(repo, "PRB-1", "executing");
    await expect(archive(true)).rejects.toThrow(refusal);
    release();
    await finished(service, run.id);
    // Nothing runs for it now: the run stopped where it stood.
    await archive(true);
    expect((await service.snapshot()).archived).toEqual([registered.id + ":PRB-1"]);
    await archive(false);
    setTicketState(repo, "PRB-1", "pr_open");
    await expect(archive(true)).rejects.toThrow(
      "PRB-1 waits on the merge decision. Archive it once its pull request is merged or closed.",
    );
    setTicketState(repo, "PRB-1", "failed");
    await archive(true);
    expect((await service.snapshot()).archived).toEqual([registered.id + ":PRB-1"]);
  });

  it("returns a filed ticket to Home for good once its loop starts again", async () => {
    const runner: typeof runProcess = async (binary, args, options) =>
      args[1] === "run"
        ? { code: 0, stdout: "{}", stderr: "", cancelled: false }
        : runProcess(binary, args, options);
    const { service, repo } = fixture(runner);
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    setTicketState(repo, "PRB-1", "failed");
    await service.request({ kind: "archive", repoId: registered.id, keys: ["PRB-1"], archived: true });
    expect((await service.snapshot()).archived).toEqual([registered.id + ":PRB-1"]);
    const run = await service.request({
      kind: "run",
      repoId: registered.id,
      key: "PRB-1",
      digest: (await service.detail(registered.id, "PRB-1")).digest,
      approve: false,
      publish: false,
      resumeFrom: null,
    });
    expect((await service.snapshot()).archived).toEqual([]);
    await finished(service, run.id);
    // Stopped again, it stays on Home until it is filed again.
    expect((await service.snapshot()).archived).toEqual([]);
  });
});

describe("usage: who is connected, and why a provider has no windows", () => {
  const signedInToBoth = () =>
    fixture(async (binary, args, runOptions) =>
      binary === "codex" || binary === "claude"
        ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", cancelled: false }
        : runProcess(binary, args, runOptions),
    );

  it("keys connected on sign-in, says not installed apart from not signed in, and asks only a signed-in CLI", async () => {
    const asked: string[] = [];
    const { service, options } = fixture(async (binary, args, runOptions) => {
      if (binary === "codex") throw new Error("spawn codex ENOENT");
      if (binary === "claude")
        return { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "", cancelled: false };
      return runProcess(binary, args, runOptions);
    });
    const asking = (id: string) => async () => {
      asked.push(id);
      return { plan: null, windows: null, detail: "Asked." };
    };
    options.usageProbe = { claude: asking("claude"), codex: asking("codex") };
    const usage = await service.request({ kind: "usage" });
    const row = (id: string) => usage.providers.find((provider) => provider.id === id);
    expect(row("codex")).toMatchObject({ connected: false, windows: null, detail: "Codex is not installed on this machine." });
    expect(row("claude")).toMatchObject({ connected: false, windows: null, detail: "Claude Code is not signed in on this machine." });
    expect(asked).toEqual([]);
  });

  it("draws a signed-in provider as connected even when it reports no window", async () => {
    const { service, options } = signedInToBoth();
    options.usageProbe = {
      claude: async () => ({ plan: null, windows: null, detail: "No window." }),
      codex: async () => ({ plan: null, windows: null, detail: "No window." }),
    };
    const usage = await service.request({ kind: "usage" });
    expect(usage.providers.filter((provider) => provider.id !== "anthropic").map((provider) => provider.connected)).toEqual([true, true]);
  });

  it("asks both CLIs at once, so neither waits on the other", async () => {
    const { service, options } = signedInToBoth();
    const asked: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = (id: string) => async () => {
      asked.push(id);
      await held;
      return { plan: null, windows: null, detail: "Held." };
    };
    options.usageProbe = { claude: holding("claude"), codex: holding("codex") };
    const usage = service.request({ kind: "usage" });
    try {
      await vi.waitFor(() => expect(asked.sort()).toEqual(["claude", "codex"]));
    } finally {
      release();
    }
    await usage;
  });
});

describe("deleting a filed ticket", () => {
  it("deletes a contract with everything it carries, whatever it has on record", async () => {
    const { service, repo } = fixture();
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
          draft: { ...draft, outcome: "Second" },
        })
      ).id,
    );
    await service.request({
      kind: "rename",
      repoId: registered.id,
      key: "PRB-1",
      title: "Renamed",
    });
    const { ticket_id } = setTicketState(repo, "PRB-2", "plan_review");
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".perbo", "state", `${ticket_id}.attempts.json`),
      JSON.stringify({ ticket_id, attempts: [{ attempt_id: "att_1" }] }),
    );
    // A recorded attempt is not a reason for the work to stay: a piece of work
    // is deleted whole at every stage, the loop included, and the evidence
    // goes with it (D-129).
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-2" });
    expect(
      existsSync(join(repo, ".perbo", "state", `${ticket_id}.attempts.json`)),
      "the attempts record",
    ).toBe(false);
    await service.request({
      kind: "discard",
      repoId: registered.id,
      key: "PRB-1",
    });
    const snapshot = await service.snapshot();
    expect(snapshot.tasks.map((row) => row.ticket.key)).toEqual([]);
    expect(snapshot.titles).toEqual({});
    for (const suffix of [".json", ".contract.json", ".draft.json"])
      expect(
        existsSync(join(repo, ".perbo", "tickets", "PRB-1" + suffix)),
      ).toBe(false);
    await expect(
      service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" }),
    ).rejects.toThrow(/no longer/);
  });

  it("takes its archive mark with it, because the key it names is never handed out again", async () => {
    // Home never lists it while the delete goes because the page that pressed
    // it hides the ticket until a read after the answer (the ui-v2 tests).
    const { service, repo, changes } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    setTicketState(repo, "PRB-1", "failed");
    await service.request({ kind: "archive", repoId: registered.id, keys: ["PRB-1"], archived: true });
    changes.length = 0;
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    const entry = registered.id + ":PRB-1";
    const said = changes.filter((change) => change.kind === "preferences");
    expect(said.length).toBeGreaterThan(0);
    for (const change of said) expect(change.archived).not.toContain(entry);
    const after = await service.snapshot();
    expect(after.tasks.some((row) => row.ticket.key === "PRB-1")).toBe(false);
  });
});

/**
 * D-NEW-publish-a-retained-branch-later: the merge press on a ticket whose run
 * retained its branch. The host runs the CLI's own delivery of it as a job,
 * argv and never a shell string, under a run's configuration with publishing
 * on and a person merging, then opens the pull request the CLI recorded. The
 * CLI is stood in for here — what it does with the branch is proven in its own
 * suite — and writes the delivery record the way it does.
 */
describe("the merge press on a retained branch", () => {
  const PULL_REQUEST = "https://github.com/example/webstore/pull/8";

  it("runs the CLI's --publish-retained as argv, then opens the pull request it recorded", async () => {
    const calls: { binary: string; args: readonly string[]; config: Record<string, unknown> }[] = [];
    let repoPath = "";
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "run") {
        calls.push({
          binary,
          args,
          config: JSON.parse(readFileSync(args[args.indexOf("--config") + 1]!, "utf8")) as Record<string, unknown>,
        });
        const path = join(repoPath, ".perbo", "tickets", "PRB-1.json");
        const ticket = JSON.parse(readFileSync(path, "utf8")) as { delivery: Record<string, unknown> };
        ticket.delivery = { ...ticket.delivery, pull_request_url: PULL_REQUEST, pull_request_number: 8, state: "open", opened_by: "loop" };
        writeFileSync(path, JSON.stringify(ticket, null, 2));
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, options } = fixture(runner);
    repoPath = repo;
    const opened: string[] = [];
    options.io.openExternal = async (url) => {
      opened.push(url);
    };
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    setTicketState(repo, "PRB-1", "pr_open");

    const job = await finished(service, (await service.request({ kind: "publish", repoId: registered.id, key: "PRB-1" })).id);

    expect(job).toMatchObject({ kind: "publish", state: "completed", error: null, label: "Open the pull request" });
    expect(lane(job.kind)).toBe("exclusive");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binary).toBe(options.nodeBinary);
    expect(calls[0]!.args.slice(1)).toEqual([
      "run",
      "--ticket",
      "PRB-1",
      "--config",
      calls[0]!.args[calls[0]!.args.indexOf("--config") + 1],
      "--publish-retained",
      "--json",
      "--repo",
      // One element, spaces and all: nothing here is a shell string.
      expect.stringMatching(/\/repository with spaces$/),
    ]);
    expect(calls[0]!.config).toMatchObject({ publish: true, merge: "person" });
    expect(opened).toEqual([PULL_REQUEST]);
    expect((await service.detail(registered.id, "PRB-1")).ticket.delivery.pull_request_url).toBe(PULL_REQUEST);
  });

  it("fails the job with the CLI's refusal, and opens nothing", async () => {
    const refusal = "error: PRB-1's retained branch was not published: main has moved to 0123456789ab. Nothing was pushed";
    const runner: typeof runProcess = async (binary, args, options) =>
      args[1] === "run" ? { code: 3, stdout: "", stderr: refusal, cancelled: false } : runProcess(binary, args, options);
    const { service, repo, options } = fixture(runner);
    const opened: string[] = [];
    options.io.openExternal = async (url) => {
      opened.push(url);
    };
    const registered = await service.registerRepository(repo);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);

    const job = await finished(service, (await service.request({ kind: "publish", repoId: registered.id, key: "PRB-1" })).id);

    expect(job.state).toBe("failed");
    expect(job.error).toBe(refusal);
    expect(opened).toEqual([]);
  });
});
