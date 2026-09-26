import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScratch } from "@perbo/test-support";
import { InterviewHost, type InterviewDeps } from "./host.js";
import { ContractEditing } from "../../shared/contract-editing.js";
import { INTERVIEW_WROTE_THE_SPEC, SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import type { PromisePair } from "../../shared/contract-editing.js";
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
  /** The child could not be run at all. */
  fail(error: Error): void {
    this.options.onError?.(error);
  }
  /** The child itself gone, with its output still held by something it started. */
  exit(): void {
    this.options.onExit?.();
  }
  close(code: number, stopped = false): void {
    this.options.onClose?.({ code, stopped } as Parameters<
      NonNullable<LineProcessOptions["onClose"]>
    >[0]);
  }
}

/** A whole interview host over an in-memory editing record and an in-memory child. */
function host(
  repo: RegisteredRepository,
  /** The catalog the chat's model is read from; none by default, so it starts on the planning's own. */
  known: InterviewDeps["catalogs"]["known"] = () => Promise.resolve(undefined),
) {
  let records: EditingSession[] = [];
  const told: Change[] = [];
  /** The planning each turn's change was marked on, with the pair it was measured from. */
  const marked: [string, PromisePair | null | undefined][] = [];
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
    specFolder: () => "specs",
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
    marks: {
      pairOf: () => PAIR,
      recordChangeSince: (id, before) => void marked.push([id, before]),
    },
    catalogs: { known },
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
    marked,
    spawned,
    interviews: new InterviewHost(deps),
    /** `new` reuses the one open draft, so a second session asks for a fresh one. */
    /** `new` reuses the one open draft, so a second session asks for a fresh one. */
    open: (target: "new" | "fresh" = "new"): Promise<EditingSession> =>
      editing.open({ kind: target, repoId }),
    conversation: (id: string): InterviewEntry[] => editing.read(id).conversation,
  };
}
/** The plan as a turn found it; what is marked against it is the marks' own test. */
const PAIR = {} as PromisePair;
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
    // The cut names the folder only: the title line says Untitled until the
    // Architect or the person names the work, and that is what is recorded as
    // the host's (D-118).
    const spec = readFileSync(
      join(repo.path, "specs", "retry-a-failed-run-without-losing-its-records", "spec.md"),
      "utf8",
    );
    expect(spec.split("\n")[0]).toBe("# Untitled");
    expect(spec).not.toContain("Retry a failed run");
    expect(w.editing.read(session.id).specCut).toBe("Untitled");
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

describe("a turn's ending", () => {
  const said = (text: string) => ({
    type: "message",
    message: { type: "assistant", message: { content: [{ type: "text", text }] } },
  });
  /** A planning named from its first turn, mid-way through that turn, with the spec moved by it. */
  async function midTurn(repo: RegisteredRepository) {
    const w = host(repo);
    const session = await w.open();
    await w.interviews.turn(session.id, "Football game");
    const child = w.spawned[0]!.child;
    child.say(started("sdk-1"));
    appendFileSync(join(repo.path, "specs", "football-game", "spec.md"), "\nExtra time is golden goal.\n");
    child.say(said("*(spec updated — still no plan)*"));
    return { w, id: session.id, child };
  }
  /** Whether the turn ended: nothing owed, its change marked, the spec handed over. */
  function ended(w: ReturnType<typeof host>, id: string): void {
    expect(w.interviews.working()).toEqual([]);
    expect(w.marked).toEqual([[id, PAIR]]);
    expect(w.conversation(id).some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC)).toBe(true);
  }

  it("ends both turns where a second, sent mid-turn, is answered inside the first", async () => {
    const { w, id, child } = await midTurn(repository());
    await w.interviews.turn(id, "why is the spec not being updated");
    child.say(said("The spec on disk is up to date."));
    expect(w.interviews.working()).toEqual([id]);
    child.say({ type: "idle", turns: 2 });
    ended(w, id);
  });

  it("keeps the second owed where it gets an ending of its own", async () => {
    const { w, id, child } = await midTurn(repository());
    await w.interviews.turn(id, "and the kick-off?");
    child.say({ type: "idle", turns: 1 });
    expect(w.interviews.working()).toEqual([id]);
    child.say({ type: "idle", turns: 1 });
    ended(w, id);
  });

  it("ends the turn a session ends in, before saying it has ended", async () => {
    const { w, id, child } = await midTurn(repository());
    child.say({ type: "ended", session_id: "sdk-1", reason: "error_during_execution" });
    ended(w, id);
    expect(w.conversation(id).at(-1)?.line).toMatchObject({ kind: "note", text: expect.stringMatching(/^The chat ended/) });
  });

  it("ends the turn the person stops, with what it changed", async () => {
    const { w, id } = await midTurn(repository());
    w.interviews.stop(id);
    ended(w, id);
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
    expect(last.text).toBe("The chat stopped with code 2.");
    expect(last.output).toBe("no provider is signed in");
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

  it("settles a stopped chat's exit once the child has gone, though its output never closes", async () => {
    // Something the chat started can hold its stdout past its own exit, and
    // then `close` never comes: a draft or a delete waiting on the exit would
    // wait for ever.
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    w.interviews.stop(session.id);
    const exited = w.interviews.exited(session.id).then(() => "exited");
    w.spawned[0]!.child.exit();
    await expect(Promise.race([exited, delay(200).then(() => "still waiting")])).resolves.toBe(
      "exited",
    );
  });

  /** A host whose catalog answers only when the test says, so a start can be caught before it spawns. */
  function held() {
    let answer: () => void = () => undefined;
    const catalog = new Promise<undefined>((resolve) => {
      answer = () => resolve(undefined);
    });
    return { w: host(repository(), () => catalog), answer };
  }

  it("spawns nothing for a planning thrown away while its chat was starting, and settles its exit", async () => {
    // The chat's model is read from the catalog before it spawns, and a delete
    // in that gap is over a chat that is not there yet.
    const { w, answer } = held();
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    const starting = w.interviews.start(session.id);
    expect(w.interviews.running(), "a chat on its way is one to stop").toEqual([session.id]);
    w.editing.discard(session.id);
    const exited = w.interviews.exited(session.id).then(() => "exited");
    answer();
    expect((await starting).running).toBe(false);
    await expect(Promise.race([exited, delay(200).then(() => "still waiting")])).resolves.toBe(
      "exited",
    );
    expect(w.spawned).toHaveLength(0);
    expect(w.interviews.running()).toEqual([]);
  });

  it("spawns nothing for a chat stopped while it was starting, so what waits on its exit is not left waiting", async () => {
    // Generate plan stops the chat and waits for it to exit: a chat spawned
    // after that stop is one nothing stops, and the draft would wait for ever.
    const { w, answer } = held();
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    const starting = w.interviews.start(session.id);
    w.interviews.stop(session.id);
    const exited = w.interviews.exited(session.id).then(() => "exited");
    answer();
    expect((await starting).running).toBe(false);
    await expect(Promise.race([exited, delay(200).then(() => "still waiting")])).resolves.toBe(
      "exited",
    );
    expect(w.spawned).toHaveLength(0);
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

/**
 * Nothing the chat shows is cut (D-NEW-nothing-shown-is-cut): the session's own
 * words that run past what the record holds are asked for again, condensed,
 * and the host's own notes carry what they quote whole.
 */
describe("words that do not fit the chat", () => {
  const saying = (text: string) => ({
    type: "message",
    message: { type: "assistant", message: { content: [{ type: "text", text }] } },
  });
  async function running() {
    const w = host(repository());
    const session = await w.open();
    w.editing.recordSpec(session.id, "retry-a-failed-run");
    await w.interviews.start(session.id);
    const child = w.spawned[0]!.child;
    child.say(started("sdk-1"));
    return { w, id: session.id, child };
  }
  const asks = (child: FakeInterview): string[] =>
    child.written.map((line) => JSON.parse(line) as { text: string }).map((turn) => turn.text).filter((text) => text.startsWith("Perbo:"));

  it("asks the session again for a message longer than the chat shows, and says the condensed one", async () => {
    const { w, id, child } = await running();
    const long = "A sentence the session wrote at length. ".repeat(400).trim();
    child.say(saying(long));
    expect(w.conversation(id).some((entry) => entry.line.kind === "said")).toBe(false);
    expect(asks(child)).toEqual([
      `Perbo: your last message runs to ${long.length.toLocaleString("en-US")} characters, more than the 12,000 ` +
        "the chat shows. Write it again, condensed to fit, and leave out nothing it says.",
    ]);
    // The ask is owed an answer like any turn, so the dock says the session is working.
    expect(w.interviews.working()).toEqual([id]);
    child.say(saying("The condensed answer."));
    child.say({ type: "idle", turns: 1 });
    expect(w.conversation(id).at(-1)?.line).toEqual({ kind: "said", text: "The condensed answer." });
    expect(w.interviews.working()).toEqual([]);
  });

  it("stops asking after twice running, and says what it did not show", async () => {
    const { w, id, child } = await running();
    const long = "x".repeat(12_001);
    child.say(saying(long));
    child.say(saying(long));
    child.say(saying(long));
    expect(asks(child)).toHaveLength(2);
    const last = w.conversation(id).at(-1)?.line;
    if (last?.kind !== "note") throw new Error("expected a note");
    expect(last.text).toBe(
      "The Architect wrote more than the chat shows, and it is not shown: your last message runs to 12,001 " +
        "characters, more than the 12,000 the chat shows, and it was asked 2 times to condense it.",
    );
    expect(w.conversation(id).some((entry) => entry.line.kind === "said")).toBe(false);
  });

  it("says so where the session is not listening to be asked", async () => {
    const { w, id, child } = await running();
    child.accepts = false;
    child.say(saying("y".repeat(12_500)));
    const last = w.conversation(id).at(-1)?.line;
    if (last?.kind !== "note") throw new Error("expected a note");
    expect(last.text).toContain("your last message runs to 12,500 characters");
    expect(asks(child)).toEqual([]);
  });

  it("asks again for a question redaction lengthened past what the chat shows", async () => {
    const { w, id, child } = await running();
    const opening = "Keep MY_API_KEY=abcdefghijklmnopqrst as it is? ";
    const question = opening + "y".repeat(600 - opening.length);
    child.say({
      type: "asked",
      groups: [{ title: null, parts: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] }],
    });
    expect(w.conversation(id).some((entry) => entry.line.kind === "asked")).toBe(false);
    expect(asks(child)).toEqual([
      "Perbo: question 1 of group 1 runs to 605 characters, more than the 600 the chat shows. Write it again, " +
        "condensed to fit, and leave out nothing it says.",
    ]);
  });

  it("says in one sentence why a chat could not run, and why one stopped, with what its process said whole behind the i", async () => {
    const { w, id, child } = await running();
    const stderr = "the provider said a great deal about why it would not serve this session. ".repeat(200);
    child.stderr(stderr);
    child.close(2);
    const stopped = w.conversation(id).at(-1)?.line;
    if (stopped?.kind !== "note") throw new Error("expected a note");
    expect(stopped.text).toBe("The chat stopped with code 2.");
    expect(stopped.output).toBe(stderr.trim());

    const again = await running();
    const why = "spawn failed: ".repeat(1_200).trim();
    again.child.fail(new Error(why));
    const failed = again.w.conversation(again.id).at(-1)?.line;
    if (failed?.kind !== "note") throw new Error("expected a note");
    expect(failed.text).toBe("The chat's process failed.");
    expect(failed.output).toBe(why);
  });

  it("redacts a credential in what a stopped chat's process said", async () => {
    const { w, id, child } = await running();
    child.stderr("the key sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz was refused\n");
    child.close(2);
    const stopped = w.conversation(id).at(-1)?.line;
    if (stopped?.kind !== "note") throw new Error("expected a note");
    expect(stopped.output).toContain("was refused");
    expect(stopped.output).not.toContain("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("says why a line could not be recorded, whole", async () => {
    const { w, id, child } = await running();
    const why = "the record refused the line for a reason it gives at length; ".repeat(300).trim();
    const converse = w.editing.converse.bind(w.editing);
    let refused = false;
    w.editing.converse = (...args: Parameters<typeof converse>) => {
      if (!refused) {
        refused = true;
        throw new Error(why);
      }
      return converse(...args);
    };
    child.say({ type: "tool", tool: "read_plan", ok: true, detail: "read" });
    const last = w.conversation(id).at(-1)?.line;
    if (last?.kind !== "note") throw new Error("expected a note");
    expect(last.text).toBe("A line of the chat could not be recorded.");
    expect(last.output).toBe(why);
  });

  it("records a refusal and a tool's report whole", async () => {
    const { w, id, child } = await running();
    const target = `/etc/${"a-directory-with-a-long-name/".repeat(60)}passwd`;
    const reason = "the guard refused it for a reason it gives at length; ".repeat(60).trim();
    child.say({ type: "refused", tool: "Bash", rule: "write_outside_worktree", target, reason });
    expect(w.conversation(id).at(-1)?.line).toEqual({ kind: "refused", tool: "Bash", rule: "write_outside_worktree", target, reason });
    const detail = "read_plan reported every node of the plan. ".repeat(400).trim();
    child.say({ type: "tool", tool: "read_plan", ok: true, detail });
    expect(w.conversation(id).at(-1)?.line).toMatchObject({ kind: "tool", detail });
  });
});
