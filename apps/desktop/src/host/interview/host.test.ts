import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { InterviewHost, type InterviewDeps } from "./host.js";
import { ContractEditing } from "../../shared/contract-editing.js";
import { SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import type { Change, EditingSession, InterviewEntry } from "../../shared/protocol.js";
import type { LineProcess, LineProcessOptions } from "../process.js";
import type { RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-interview-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "tickets"), { recursive: true });
  return { id: repoId, name: "checkout", path };
}

/** The interview's own process, in memory: what was written, and lines pushed back. */
class FakeInterview {
  readonly written: string[] = [];
  private readonly options: Omit<LineProcessOptions, "cwd" | "env">;
  accepts = true;
  stopped = false;

  constructor(options: Omit<LineProcessOptions, "cwd" | "env">) {
    this.options = options;
  }

  process(): LineProcess {
    return {
      write: (text: string) => {
        if (!this.accepts) return false;
        this.written.push(text);
        return true;
      },
      stop: () => {
        this.stopped = true;
      },
    } as unknown as LineProcess;
  }

  say(event: Record<string, unknown>): void {
    this.options.onLine?.(JSON.stringify(event));
  }
  stderr(text: string): void {
    this.options.onStderr?.(text);
  }
  close(code: number, stopped = false): void {
    this.options.onClose?.({ code, stopped } as Parameters<
      NonNullable<LineProcessOptions["onClose"]>
    >[0]);
  }
}

/** A whole interview host over an in-memory editing record and an in-memory child. */
function host(repo: RegisteredRepository) {
  let records: EditingSession[] = [];
  const told: Change[] = [];
  const spawned: { args: string[]; child: FakeInterview }[] = [];
  const editing = new ContractEditing({
    records: () => records,
    persist: (next) => {
      records = structuredClone(next);
    },
    repository: () => undefined,
    defaults: () => TaskModelsSchema.strip().parse(SettingsSchema.parse({})),
    detail: () => {
      throw new Error("no detail in this test");
    },
    start: () => {
      throw new Error("no job in this test");
    },
    stop: () => Promise.resolve(),
    id: () => crypto.randomUUID(),
    standing: () => [],
    setStanding: () => undefined,
  });
  const deps: InterviewDeps = {
    editing,
    repository: () => repo,
    tickets: {
      contract: () => {
        throw new Error("no contract in this test");
      },
    },
    detail: () => Promise.reject(new Error("no detail in this test")),
    marks: { pairOf: () => null, recordChangeSince: () => undefined },
    // No catalog to read: the chat starts on the planning's own model.
    catalogs: { known: () => Promise.resolve(undefined) },
    sessions: () => records,
    draftedFrom: () => Promise.resolve(null),
    reread: () => undefined,
    cli: {
      spawn: (args, _repo, options) => {
        const child = new FakeInterview(options);
        spawned.push({ args, child });
        return child.process();
      },
    },
    changes: {
      changed: (_persist?: boolean, change?: Change | Parameters<InterviewDeps["changes"]["changed"]>[1]) => {
        told.push(change as Change);
      },
    } as InterviewDeps["changes"],
  };
  return {
    editing,
    told,
    spawned,
    interviews: new InterviewHost(deps),
    /** `new` reuses the one open draft, so a second session asks for a fresh one. */
    /** `new` reuses the one open draft, so a second session asks for a fresh one. */
    open: (target: "new" | "fresh" = "new"): Promise<EditingSession> =>
      editing.open({ kind: target, repoId }),
    conversation: (id: string): InterviewEntry[] => editing.read(id).conversation,
  };
}
const started = (session: string): Record<string, unknown> => ({
  type: "started",
  session_id: session,
  spec: "specs/retry/spec.md",
  adr: "docs/adr",
  model: "opus",
  tools: ["edit_plan"],
});

describe("starting an interview", () => {
  it("refuses a planning that belongs to another repository", async () => {
    const w = host(repository());
    const session = await w.open();
    await expect(
      w.interviews.start(session.id, "80000000-0000-4000-8000-00000000000f"),
    ).rejects.toThrow("This planning belongs to another repository.");
  });

  it("refuses to start before the spec has a name", async () => {
    const w = host(repository());
    const session = await w.open();
    await expect(w.interviews.start(session.id)).rejects.toThrow();
    expect(w.spawned).toHaveLength(0);
    // A refusal leaves no interview behind for the snapshot to count.
    expect(w.interviews.running()).toEqual([]);
  });

  it("starts one child per session, and says it is running before it has spoken", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    const status = await w.interviews.start(session.id);
    expect(status.running).toBe(true);
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]?.args.slice(0, 3)).toEqual([
      "interview",
      "--spec",
      "specs/retry-a-failed-run",
    ]);
    await w.interviews.start(session.id);
    expect(w.spawned).toHaveLength(1);
    expect(w.interviews.running()).toEqual([session.id]);
  });

  it("records the session the interview reported, which a later start continues", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    w.spawned[0]!.child.say(started("sdk-1"));
    expect(w.editing.read(session.id).interviewSession).toBe("sdk-1");
    expect(w.conversation(session.id).at(-1)?.line).toMatchObject({ kind: "note" });
    w.spawned[0]!.child.close(0);
    await w.interviews.start(session.id);
    expect(w.spawned[1]?.args).toContain("--session");
    expect(w.spawned[1]?.args).toContain("sdk-1");
  });

  it("says what the session said, as the chat shows it", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    w.spawned[0]!.child.say({
      type: "message",
      message: { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
    });
    expect(w.conversation(session.id).at(-1)?.line).toEqual({ kind: "said", text: "Hello" });
  });
});

describe("a person's turn", () => {
  it("names the spec from the first message where the pane has not", async () => {
    const repo = repository();
    const w = host(repo);
    const session = await w.open();
    await w.interviews.turn(session.id, "Retry a failed run without losing its records");
    expect(w.editing.read(session.id).specSlug).toBe("retry-a-failed-run-without-losing-its-records");
    expect(
      readFileSync(
        join(repo.path, "specs", "retry-a-failed-run-without-losing-its-records", "spec.md"),
        "utf8",
      ),
    ).toContain("Retry a failed run");
    expect(w.conversation(session.id).some((entry) => entry.line.kind === "turn")).toBe(true);
  });

  it("asks for a title where the message names nothing", async () => {
    const w = host(repository());
    const session = await w.open();
    await expect(w.interviews.turn(session.id, "?!?!")).rejects.toThrow(/spec title first/);
    expect(w.editing.read(session.id).specSlug).toBeNull();
    expect(w.spawned).toHaveLength(0);
  });

  it("writes the turn down the child's stdin, and records it once it has", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    await w.interviews.turn(session.id, "Start with the retry button");
    expect(w.spawned[0]?.child.written.join("")).toContain("Start with the retry button");
    expect(w.conversation(session.id).at(-1)?.line).toEqual({
      kind: "turn",
      text: "Start with the retry button",
    });
  });

  it("says the chat is not listening where the child would not take it", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    w.spawned[0]!.child.accepts = false;
    await expect(w.interviews.turn(session.id, "Anybody there?")).rejects.toThrow(
      "The chat is not listening.",
    );
  });
});

describe("stopping", () => {
  it("ends the child's stdin and keeps it running until it has gone", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    expect(w.interviews.stop(session.id).running).toBe(true);
    expect(w.spawned[0]?.child.stopped).toBe(true);
    w.spawned[0]!.child.close(0, true);
    expect(w.interviews.status(session.id).running).toBe(false);
  });

  it("says why a child that stopped on its own stopped, with what it wrote", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    w.spawned[0]!.child.stderr("no provider is signed in\n");
    w.spawned[0]!.child.close(2);
    const last = w.conversation(session.id).at(-1)?.line;
    expect(last).toMatchObject({ kind: "note" });
    if (last?.kind !== "note") throw new Error("expected a note");
    expect(last.text).toContain("The chat stopped with code 2.");
    expect(last.text).toContain("no provider is signed in");
  });

  it("says nothing extra where it was stopped by the person", async () => {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    const before = w.conversation(session.id).length;
    w.spawned[0]!.child.close(0, true);
    expect(w.conversation(session.id).length).toBe(before);
    expect(w.interviews.running()).toEqual([]);
  });

  it("ends every interview when the app closes", async () => {
    const w = host(repository());
    const first = await w.open();
    const second = await w.open("fresh");
    w.editing.recordSpec(first.id, "retry-one");
    w.editing.recordSpec(second.id, "retry-two");
    await w.interviews.start(first.id);
    await w.interviews.start(second.id);
    expect(w.interviews.running()).toHaveLength(2);
    w.interviews.shutdown();
    expect(w.spawned.every((entry) => entry.child.stopped)).toBe(true);
    expect(w.interviews.running()).toEqual([]);
  });
});
