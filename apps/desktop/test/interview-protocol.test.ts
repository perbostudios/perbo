import { describe, expect, it } from "vitest";
import {
  ChangeSchema,
  EditingSessionSchema,
  INTERVIEW_CONVERSATION_CAP,
  InterviewEntrySchema,
  RequestSchema,
} from "../src/shared/protocol.js";
import { PLANNING_KINDS } from "../src/shared/jobs.js";
import { editingForm } from "../src/shared/contract-editing.js";
import { SettingsSchema, TaskModelsSchema } from "../src/shared/protocol.js";

/**
 * The interview's three requests are closed (ADR-0023, D-102): the renderer
 * names a repository and its own editing session, and for a turn the text the
 * person typed. Nothing that a filesystem or a shell could take crosses — the
 * spec folder, the session to continue and the model are all the host's to
 * derive from the registered repository and the session's own records.
 */

const repoId = "80000000-0000-4000-8000-000000000001";
const id = "80000000-0000-4000-8000-000000000002";

describe("the interview's protocol", () => {
  it("takes a repository and an editing session to start, a turn, and a stop", () => {
    expect(RequestSchema.safeParse({ kind: "interviewStart", repoId, id }).success).toBe(true);
    expect(RequestSchema.safeParse({ kind: "interviewTurn", id, text: "why two nodes?" }).success).toBe(true);
    expect(RequestSchema.safeParse({ kind: "interviewStop", id }).success).toBe(true);
  });

  it("refuses a path, a command, a session or a model on any of the three", () => {
    for (const request of [
      { kind: "interviewStart", repoId, id, spec: "specs/a-light-colour-mode" },
      { kind: "interviewStart", repoId, id, args: ["--repo", "/etc"] },
      { kind: "interviewStart", repoId, id, session: "sdk-session-1" },
      { kind: "interviewStart", repoId, id, model: "claude-opus-5" },
      { kind: "interviewStart", repoId, id, cwd: "/etc" },
      { kind: "interviewStart", repoId },
      { kind: "interviewTurn", id, text: "hello", spec: "specs/x" },
      { kind: "interviewTurn", id, text: "hello", path: "src/index.ts" },
      { kind: "interviewTurn", id, text: "" },
      { kind: "interviewTurn", id },
      { kind: "interviewStop", id, signal: "SIGKILL" },
      { kind: "interviewStop", id, pid: 4021 },
      { kind: "interviewStop" },
    ])
      expect(RequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  /** The lane D-101 puts planning in: never in the way of a run, and never held up by one. */
  it("places all three in the planning lane", () => {
    for (const kind of ["interviewStart", "interviewTurn", "interviewStop"])
      expect(PLANNING_KINDS as readonly string[], kind).toContain(kind);
  });

  it("carries one relayed line, and what is running, on its own change", () => {
    const entry = {
      n: 1,
      at: "2026-01-01T00:00:00.000Z",
      line: { kind: "said", text: "Which part of the queue is this about?" },
    };
    expect(
      ChangeSchema.safeParse({ kind: "interview", sequence: 3, sessionId: id, running: true, entry }).success,
    ).toBe(true);
    // A start and a stop say what is running with no line to add.
    expect(
      ChangeSchema.safeParse({ kind: "interview", sequence: 4, sessionId: id, running: false, entry: null }).success,
    ).toBe(true);
    // The raw stdout line never travels: every entry is one of the five shapes.
    expect(
      ChangeSchema.safeParse({
        kind: "interview",
        sequence: 5,
        sessionId: id,
        running: true,
        entry: { n: 2, at: "2026-01-01T00:00:00.000Z", line: { kind: "raw", text: "{}" } },
      }).success,
    ).toBe(false);
  });

  it("shows a refusal as a refusal, with no answer to give it", () => {
    const refused = {
      n: 1,
      at: "2026-01-01T00:00:00.000Z",
      line: {
        kind: "refused",
        tool: "Bash",
        rule: "allow_list",
        target: "pnpm test",
        reason: "pnpm test is not one of the read-only shapes this session may run",
      },
    };
    expect(InterviewEntrySchema.safeParse(refused).success).toBe(true);
    // Nothing on a refusal takes an answer: it is reported, never put to the person (D-102).
    for (const extra of [{ allow: true }, { decision: "deny" }, { options: ["allow", "deny"] }])
      expect(
        InterviewEntrySchema.safeParse({ ...refused, line: { ...refused.line, ...extra } }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });
});

describe("the conversation an editing session keeps", () => {
  const base = {
    version: 1 as const,
    id,
    repoId,
    key: null,
    digest: null,
    revision: 0,
    resumeNew: false,
    form: editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({}))),
    phase: "editing" as const,
    error: null,
    operation: null,
  };
  const entry = (n: number) => ({
    n,
    at: "2026-01-01T00:00:00.000Z",
    line: { kind: "turn" as const, text: `turn ${n}` },
  });

  it("defaults to none, so a session saved before the chat existed still parses", () => {
    const parsed = EditingSessionSchema.parse(base);
    expect(parsed.conversation).toEqual([]);
    expect(parsed.interviewSession).toBeNull();
  });

  it("round-trips through the record, keeping each line's number and author", () => {
    const conversation = [
      entry(1),
      { n: 2, at: "2026-01-01T00:00:01.000Z", line: { kind: "said", text: "Two nodes, because the retry path is separate." } },
      {
        n: 3,
        at: "2026-01-01T00:00:02.000Z",
        line: {
          kind: "tool",
          tool: "edit_plan",
          ok: true,
          detail: "PRB-1: edit 1 — Split the queue node in two",
          edit: {
            n: 1,
            author: "interview",
            summary: "Split the queue node in two",
            undone: false,
            undoes: null,
            before: ["node:node_1"],
            after: ["node:node_1", "node:node_3"],
          },
        },
      },
    ];
    const written = EditingSessionSchema.parse({ ...base, conversation, interviewSession: "sdk-1" });
    const read = EditingSessionSchema.parse(JSON.parse(JSON.stringify(written)));
    expect(read.conversation).toEqual(conversation);
    expect(read.interviewSession).toBe("sdk-1");
  });

  it("holds the cap and no more, so a long conversation cannot grow the record for ever", () => {
    const many = Array.from({ length: INTERVIEW_CONVERSATION_CAP }, (_, index) => entry(index + 1));
    expect(EditingSessionSchema.safeParse({ ...base, conversation: many }).success).toBe(true);
    expect(
      EditingSessionSchema.safeParse({ ...base, conversation: [...many, entry(INTERVIEW_CONVERSATION_CAP + 1)] })
        .success,
    ).toBe(false);
  });
});
