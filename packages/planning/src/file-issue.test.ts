import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanningError } from "./errors.js";
import {
  MAX_ISSUE_FILE_BYTES,
  fileReference,
  parseIssueMarkdown,
  readIssueFile,
} from "./file-issue.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-planning-file-issue-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const write = (name: string, text: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};

describe("readIssueFile", () => {
  it("reads the first line as the title and the remainder as the body", () => {
    const path = write(
      "SCP-150.md",
      "Admit from a pasted issue body\n\nSomebody sent this in a message.\n\nSteps: paste it.\n",
    );
    expect(readIssueFile(path)).toEqual({
      reference: "file:SCP-150.md",
      title: "Admit from a pasted issue body",
      body: "Somebody sent this in a message.\n\nSteps: paste it.",
      // The title is the file's line 1 and the body its line 3: the blank line
      // between them is dropped from the text but counted here, so anything
      // reporting a line later names the line the file actually has.
      source_lines: { title: 1, body: 3 },
    });
  });

  it("carries no issue number and no URL, because a file has neither", () => {
    const issue = readIssueFile(write("no-url.md", "A title\n\nA body.\n"));
    expect(issue.number).toBeUndefined();
    expect(issue.url).toBeUndefined();
    expect(Object.keys(issue).sort()).toEqual(["body", "reference", "source_lines", "title"]);
  });

  it("names the file, never the path it was found at", () => {
    const nested = join(scratch, "nested");
    mkdirSync(nested, { recursive: true });
    const path = join(nested, "SCP-151.md");
    writeFileSync(path, "T\n\nb\n");
    expect(readIssueFile(path).reference).toBe("file:SCP-151.md");
    expect(fileReference(path)).toBe("file:SCP-151.md");
  });

  it("takes a Markdown heading as the title, without its marker", () => {
    expect(parseIssueMarkdown("## Users get no email\n\nSince Tuesday.", "file:x.md").title).toBe(
      "Users get no email",
    );
  });

  it("skips leading blank lines rather than reading an empty title", () => {
    expect(parseIssueMarkdown("\n\n  A title  \n\nbody\n", "file:x.md")).toEqual({
      reference: "file:x.md",
      title: "A title",
      body: "body",
      // Two blank lines above the title and one below it: the title is line 3
      // of the file and the body line 5, whatever was skipped to find them.
      source_lines: { title: 3, body: 5 },
    });
  });

  it("numbers the title and the body at the lines the file itself has them on", () => {
    // Checked against the file rather than against an expected pair: the point
    // of the number is that opening the file at it lands on the right line.
    const text = ["", "# Users get no email", "", "", "The mailer returns 500.", ""].join("\n");
    const path = write("numbered.md", text);
    const { source_lines: lines } = readIssueFile(path);
    const onDisk = readFileSync(path, "utf8").split("\n");
    expect(onDisk[lines!.title - 1]).toBe("# Users get no email");
    expect(onDisk[lines!.body - 1]).toBe("The mailer returns 500.");
  });

  it("reads a file with no body as a title and an empty body", () => {
    expect(readIssueFile(write("title-only.md", "Just the title\n")).body).toBe("");
  });

  it("reads CRLF and a byte-order mark the same as plain UTF-8", () => {
    expect(readIssueFile(write("crlf.md", "\uFEFFA title\r\n\r\nLine one.\r\nLine two.\r\n"))).toEqual({
      reference: "file:crlf.md",
      title: "A title",
      body: "Line one.\nLine two.",
      source_lines: { title: 1, body: 3 },
    });
  });

  it("says one sentence when the file is not there, is a directory, or is empty", () => {
    expect(() => readIssueFile(join(scratch, "missing.md"))).toThrow(PlanningError);
    expect(() => readIssueFile(join(scratch, "missing.md"))).toThrow(/no file at .*missing\.md/);

    const dir = join(scratch, "a-directory.md");
    mkdirSync(dir, { recursive: true });
    expect(() => readIssueFile(dir)).toThrow(/is a directory; --from-file takes one Markdown file/);

    expect(() => readIssueFile(write("blank.md", "\n \n\t\n"))).toThrow(
      /file:blank\.md has no text/,
    );
  });

  it("leaves a title that opens with an issue number alone", () => {
    // `#412 is broken` is a reference, not a Markdown heading: the marker is
    // only stripped where a heading actually has one, followed by whitespace.
    expect(parseIssueMarkdown("#412 activation email never arrives\n\nb", "file:x.md").title).toBe(
      "#412 activation email never arrives",
    );
  });

  it("refuses a paste that is a log rather than an issue", () => {
    const path = write("huge.md", `A title\n\n${"x".repeat(MAX_ISSUE_FILE_BYTES)}`);
    expect(() => readIssueFile(path)).toThrow(/past the 1024 KiB an issue body may be/);
  });
});
