import { describe, expect, it } from "vitest";
import { interviewSaid, readable, relayed } from "./relay.js";

const line = (event: Record<string, unknown>): string => JSON.stringify(event);
const said = (text: string): string =>
  line({
    type: "message",
    message: { type: "assistant", message: { content: [{ type: "text", text }] } },
  });

describe("relayed", () => {
  it("says a line that is not JSON could not be read, and never relays it", () => {
    expect(relayed("this is not JSON {")).toEqual({
      kind: "line",
      line: {
        kind: "note",
        text: "The chat wrote a line this build could not read: it is not JSON.",
      },
    });
  });

  it("says why a line is not one of the chat's events, clipped", () => {
    const read = relayed(line({ type: "unheard-of" }));
    if (read.kind !== "line" || read.line.kind !== "note") throw new Error("expected a note");
    expect(read.line.text).toContain("it is not one of the chat's events");
    expect(read.line.text.length).toBeLessThan(2_200);
  });

  it("reads what the session said, and nothing where it said nothing", () => {
    expect(relayed(said("Completed the change."))).toEqual({
      kind: "said",
      text: "Completed the change.",
    });
    expect(relayed(said("   ")).kind).toBe("nothing");
  });

  it("redacts a credential the session put on the wire", () => {
    const read = relayed(said("The key is sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz"));
    if (read.kind !== "said") throw new Error("expected what the session said");
    expect(read.text).not.toContain("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("clips a session id to what the record holds, and keeps it out of the chat", () => {
    const read = relayed(
      line({
        type: "started",
        session_id: "s".repeat(400),
        spec: "specs/retry/spec.md",
        adr: "docs/adr/NEW-retry.md",
        model: "opus",
        tools: ["edit_plan"],
      }),
    );
    if (read.kind !== "started") throw new Error("expected a started reading");
    expect(read.session).toHaveLength(200);
    if (read.note.kind !== "note") throw new Error("expected a note");
    // No session id reaches the conversation, however long it was: it is of no
    // use to anybody reading the chat. What the note says is the folder the
    // session may write that is on screen nowhere.
    expect(read.note.text).not.toContain("s".repeat(40));
    expect(read.note.text).toContain("specs/retry/spec.md");
    expect(read.note.text).toContain("docs/adr/NEW-retry.md");
  });

  it("says a turn ended with nothing to show, which is how a pause is told from a stop", () => {
    expect(relayed(line({ type: "idle", turns: 2 }))).toEqual({ kind: "idle", turns: 2 });
  });

  it("says the session wrote the spec, and nothing of what it wrote", () => {
    expect(relayed(line({ type: "wrote_spec" }))).toEqual({ kind: "wroteSpec" });
  });

  it("redacts a credential the reason names, however many fields it runs to", () => {
    const many: Record<string, unknown> = { type: "started" };
    many["sk-ant-notreal0123456789"] = "x";
    for (let at = 0; at < 900; at += 1) many[`unrecognised_key_${at}`] = "x";
    const read = relayed(line(many));
    if (read.kind !== "line" || read.line.kind !== "note") throw new Error("expected a note");
    expect(read.line.text.startsWith("The chat wrote a line this build")).toBe(true);
    expect(read.line.text.length).toBeLessThan(2_200);
    expect(read.line.text).not.toContain("sk-ant-notreal0123456789");
  });

  it("carries a refusal as refused, with each field clipped", () => {
    const read = relayed(
      line({
        type: "refused",
        tool: "t".repeat(400),
        rule: "r".repeat(400),
        target: "/etc/passwd",
        reason: "x".repeat(4000),
      }),
    );
    if (read.kind !== "line" || read.line.kind !== "refused") throw new Error("expected refused");
    expect(read.line.tool).toHaveLength(200);
    expect(read.line.rule).toHaveLength(200);
    expect(read.line.reason).toHaveLength(2000);
    expect(read.line.target).toBe("/etc/passwd");
  });

  it("says a plan moved only where an edit tool succeeded", () => {
    const tool = (name: string, ok: boolean): ReturnType<typeof relayed> =>
      relayed(line({ type: "tool", tool: name, ok, detail: "done" }));
    expect(tool("edit_plan", true)).toMatchObject({ kind: "tool", planMoved: true });
    expect(tool("undo_edit", true)).toMatchObject({ kind: "tool", planMoved: true });
    expect(tool("edit_plan", false)).toMatchObject({ kind: "tool", planMoved: false });
    expect(tool("read_file", true)).toMatchObject({ kind: "tool", planMoved: false });
  });

  it("flattens the whitespace in an asking, and names what redaction emptied", () => {
    const read = relayed(
      line({
        type: "asked",
        groups: [
          {
            title: "A\ntitle\tacross lines",
            parts: [
              {
                question: "Which\nway?",
                options: [
                  { label: "\u001b[31m", detail: null, recommended: false },
                  { label: "This way", detail: "Because", recommended: true },
                ],
              },
            ],
          },
        ],
      }),
    );
    if (read.kind !== "asked") throw new Error("expected an asking");
    const group = read.line.groups[0]!;
    expect(group.title).toBe("A title across lines");
    // A title redaction emptied is the interviewer asking, by its name.
    const untitled = relayed(
      line({
        type: "asked",
        groups: [
          {
            title: "\u001b[31m",
            parts: [
              {
                question: "Which?",
                options: [
                  { label: "A", detail: null, recommended: true },
                  { label: "B", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
      }),
    );
    if (untitled.kind !== "asked") throw new Error("expected an asking");
    expect(untitled.line.groups[0]?.title).toBe("The Architect asks");
    expect(group.parts[0]?.question).toBe("Which way?");
    expect(group.parts[0]?.options[0]?.label).toBe("(unreadable answer)");
    expect(group.parts[0]?.options[1]).toMatchObject({
      label: "This way",
      detail: "Because",
      recommended: true,
    });
  });

  it("says the chat ended, with its reason", () => {
    expect(relayed(line({ type: "ended", session_id: "s1", reason: "the session closed" }))).toEqual({
      kind: "ended",
      line: { kind: "note", text: "The chat ended: the session closed." },
    });
  });
});

describe("readable", () => {
  it("redacts, flattens and clips a model's text, and says nothing where nothing survived", () => {
    expect(readable("one\n two\tthree", 200)).toBe("one two three");
    expect(readable("abcdef", 3)).toBe("abc");
    expect(readable("\u001b[31m", 200)).toBe("");
    expect(readable("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz", 200)).not.toContain(
      "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz",
    );
  });
});

describe("interviewSaid", () => {
  it("joins the text blocks of an assistant message", () => {
    expect(
      interviewSaid({
        type: "assistant",
        message: { content: [{ type: "text", text: "One" }, { type: "text", text: "Two" }] },
      }),
    ).toBe("One\nTwo");
  });

  it("says nothing for a shape that is not one", () => {
    for (const message of [
      { type: "result" },
      { type: "assistant", message: { content: [{ type: "thinking" }] } },
      { type: "assistant", message: {} },
      {},
    ])
      expect(interviewSaid(message as Record<string, unknown>)).toBeNull();
  });
});
