// @vitest-environment jsdom
import { expect, expectTypeOf, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRoutes, requestKinds } from "../src/host/routes.js";
import type { HostModules } from "../src/host/routes.js";
import { disposeFixtures, fixture } from "../src/host/test-support/host-fixture.js";
import { handlers } from "../src/sample-host/handlers.js";
import { sampleBridge } from "../src/sample-host/bridge.js";
import { runProcess } from "../src/host/process.js";
import type { Change, DesktopBridge, Draft, Job, ReplyMap, Request } from "../src/shared/protocol.js";
import { describeBridgeContract } from "./support/bridge-contract.js";

/**
 * Every reply the protocol declares belongs to a kind it declares, and every
 * kind has one. Checked as a type because both tables are typed against it: a
 * `ReplyMap` key with no request would make each of them unwritable.
 */
it("declares one reply per request kind", () => {
  expectTypeOf<keyof ReplyMap>().toEqualTypeOf<Request["kind"]>();
  expect(requestKinds().length).toBeGreaterThan(0);
});

it("answers every request kind from the sample host, and nothing else", () => {
  expect(Object.keys(handlers).sort()).toEqual(requestKinds());
});

/**
 * The host's capability map is closures over the modules it is given, and its
 * keys are the same whatever those modules are — which is why it can be asked
 * for them without a host behind it.
 */
it("answers every request kind from the host's routes, and nothing else", () => {
  expect(Object.keys(createRoutes({} as unknown as HostModules)).sort()).toEqual(requestKinds());
});

/** A run the executor never finishes, so the exclusive lane stays occupied. */
function heldRunner() {
  let release!: () => void;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: typeof runProcess = async (binary, args, options) => {
    if (args[1] === "approve") return { code: 0, stdout: "{}", stderr: "", cancelled: false };
    if (args[1] === "run") {
      await Promise.race([
        until,
        new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return { code: 0, stdout: "{}", stderr: "", cancelled: Boolean(options.signal?.aborted) };
    }
    return runProcess(binary, args, options);
  };
  return { runner, release };
}

const hostDraft: Draft = {
  outcome: "Hold one run while the protocol is asked what it promises",
  criteria: [{ text: "The run is held", assertion: "The runner does not return", kind: "test" }],
  paths: ["src/**"],
  prohibited: [],
};

async function settled(bridge: DesktopBridge, id: string): Promise<Job> {
  for (let count = 0; count < 600; count++) {
    const job = (await bridge.request({ kind: "snapshot" })).jobs.find((entry) => entry.id === id);
    if (job && !["running", "stopping"].includes(job.state)) return job;
    await delay(20);
  }
  throw new Error("Desktop command did not settle");
}

describeBridgeContract("the sample host", async () => {
  localStorage.clear();
  const changes: Change[] = [];
  const stop = sampleBridge.subscribe((change) => changes.push(change));
  const repoId = (await sampleBridge.request({ kind: "snapshot" })).repositories[0]!.id;
  let held: Job | null = null;
  return {
    bridge: sampleBridge,
    repoId,
    unapprovedKey: "PRB-421",
    runnableKey: "PRB-412",
    startHeldRun: async (key) => {
      const detail = await sampleBridge.request({ kind: "detail", repoId, key });
      held = await sampleBridge.request({
        kind: "run",
        repoId,
        key,
        digest: detail.digest,
        publish: false,
        approve: true,
        resumeFrom: null,
      });
      return held;
    },
    changes,
    dispose: async () => {
      stop();
      if (held)
        await sampleBridge.request({ kind: "cancel", jobId: held.id }).catch(() => undefined);
    },
  };
});

describeBridgeContract("the host", async () => {
  const holder = heldRunner();
  const made = fixture(holder.runner);
  const bridge: DesktopBridge = {
    request: (request) => made.service.request(request),
    subscribe: () => () => undefined,
  };
  const repository = await made.service.registerRepository(made.repo);
  for (const outcome of [hostDraft.outcome, "A second contract nobody approved"])
    await settled(
      bridge,
      (
        await bridge.request({
          kind: "admit",
          repoId: repository.id,
          draft: { ...hostDraft, outcome },
        })
      ).id,
    );
  let held: Job | null = null;
  return {
    bridge,
    repoId: repository.id,
    unapprovedKey: "PRB-2",
    runnableKey: "PRB-1",
    startHeldRun: async (key) => {
      const detail = await bridge.request({ kind: "detail", repoId: repository.id, key });
      held = await bridge.request({
        kind: "run",
        repoId: repository.id,
        key,
        digest: detail.digest,
        publish: false,
        approve: true,
        resumeFrom: null,
      });
      return held;
    },
    changes: made.changes,
    dispose: async () => {
      if (held) await bridge.request({ kind: "cancel", jobId: held.id }).catch(() => undefined);
      holder.release();
      await disposeFixtures();
    },
  };
});

/**
 * The standing prohibited list is the repository's own, not the draft's
 * (D-105): a mark made with the always box lands in `.perbo/config.json` and
 * binds every later run, and undoing that mark takes it back out. Only the
 * host has a repository to write it to.
 */
it("writes a standing mark into the repository's configuration, and undo removes it", async () => {
  const { service, repo } = fixture();
  try {
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ test_command: "pnpm test" }));
    const registered = await service.registerRepository(repo);
    const config = (): unknown =>
      JSON.parse(readFileSync(join(repo, ".perbo", "config.json"), "utf8"));
    const opened = await service.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: registered.id },
    });
    const marked = await service.request({
      kind: "explorerMark",
      id: opened.id,
      revision: opened.revision,
      path: "src/generated/",
      mark: "prohibited",
      always: true,
    });
    expect(marked.form.draft.prohibited).toEqual(["src/generated/**"]);
    expect(config()).toEqual({
      test_command: "pnpm test",
      paths_prohibited: [
        {
          path: "src/generated/**",
          draft: opened.id,
          source: "this draft",
          added_at: expect.any(String) as unknown as string,
        },
      ],
    });
    const undone = await service.request({
      kind: "explorerUndo",
      id: marked.id,
      revision: marked.revision,
      edit: marked.history.at(-1)!.n,
    });
    expect(undone.form.draft.prohibited).toEqual([]);
    expect(config()).toEqual({ test_command: "pnpm test", paths_prohibited: [] });
  } finally {
    await disposeFixtures();
  }
});
