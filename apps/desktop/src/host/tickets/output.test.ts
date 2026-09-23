import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { retainedOutput } from "./output.js";
import { objectPath, objectsPath } from "../repository/layout.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Detail } from "../../shared/protocol.js";
import type { RunBundle } from "@perbo/contracts";

const scratchDirectory = createScratch("perbo-output-");
afterEach(() => {
  scratchDirectory.removeAll();
});
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(path, { recursive: true });
  return { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
}
const body = '{"type":"assistant","message":{"content":[{"type":"text","text":"Completed the change."}]}}';
/** Writes an object as the run sealed it, and answers the artifact that names it. */
function sealed(
  repo: RegisteredRepository,
  name: "transcript.jsonl" | "change.diff",
  content: string | Buffer,
): RunBundle["artifacts"][number] {
  const hash = createHash("sha256").update(name).digest("hex");
  mkdirSync(objectsPath(repo), { recursive: true });
  writeFileSync(objectPath(repo, hash), content);
  return {
    name,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    retained: true,
    media_type: "application/x-ndjson",
  };
}
function bundle(
  over: Partial<RunBundle> & { artifacts: RunBundle["artifacts"] },
): RunBundle {
  return {
    kind: "execution",
    subject_id: "att_output",
    ticket_id: "ticket_1",
    ...over,
  } as RunBundle;
}
function detail(bundles: RunBundle[], attempts: { id: string; bundles: RunBundle[] }[] = []): Detail {
  return {
    ticket: { ticket_id: "ticket_1" },
    attempts: [{ id: "att_output", bundles }, ...attempts],
  } as Detail;
}
/** The object's name on disk is its artifact's sha256 in the sealed record. */
const named = (repo: RegisteredRepository, artifact: { sha256: string }, content: string | Buffer): void => {
  mkdirSync(objectsPath(repo), { recursive: true });
  writeFileSync(objectPath(repo, artifact.sha256), content);
};

describe("retainedOutput", () => {
  it("reads the transcript the attempt's own bundle sealed", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    named(repo, artifact, body);
    const output = retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output");
    expect(output.transcript).toBe(body);
    expect(output.diff).toBeNull();
    expect(output.notes).toEqual([]);
  });

  it("reads the last attempt where none is named", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    named(repo, artifact, body);
    const record = detail([bundle({ artifacts: [artifact] })]);
    record.attempts.push({ ...record.attempts[0]!, id: "att_newer", bundles: [] });
    expect(retainedOutput(repo, record).transcript).toBeNull();
    expect(retainedOutput(repo, record, "att_output").transcript).toBe(body);
  });

  it("refuses an attempt that does not belong to this task", () => {
    const repo = repository();
    expect(() => retainedOutput(repo, detail([]), "att_foreign")).toThrow(
      "The selected attempt does not belong to this task.",
    );
  });

  it("shows nothing for a bundle sealed against another ticket", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    named(repo, artifact, body);
    const output = retainedOutput(
      repo,
      detail([bundle({ artifacts: [artifact], ticket_id: "ticket_someone_else" })]),
      "att_output",
    );
    expect(output.transcript).toBeNull();
    expect(output.notes).toEqual([]);
  });

  it("shows nothing for a bundle sealed by another attempt, or of another kind", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    named(repo, artifact, body);
    expect(
      retainedOutput(repo, detail([bundle({ artifacts: [artifact], subject_id: "att_other" })]), "att_output")
        .transcript,
    ).toBeNull();
    expect(
      retainedOutput(repo, detail([bundle({ artifacts: [artifact], kind: "review" })]), "att_output")
        .transcript,
    ).toBeNull();
  });

  it("says so where the bytes no longer hash to what was sealed", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    named(repo, artifact, "changed after sealing");
    const output = retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output");
    expect(output.transcript).toBeNull();
    expect(output.notes).toEqual([expect.stringContaining("content hash")]);
  });

  it("says so rather than reading an object that has grown past the cap", () => {
    const repo = repository();
    const large = Buffer.alloc(2_000_001);
    const artifact = sealed(repo, "transcript.jsonl", large);
    named(repo, artifact, large);
    const output = retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output");
    expect(output.transcript).toBeNull();
    expect(output.notes).toEqual([expect.stringContaining("2 MB")]);
  });

  it("refuses an object reached through a link", () => {
    const repo = repository();
    const artifact = sealed(repo, "transcript.jsonl", body);
    const outside = join(repo.path, "..", "outside-record.txt");
    writeFileSync(outside, body);
    rmSync(objectPath(repo, artifact.sha256), { force: true });
    symlinkSync(outside, objectPath(repo, artifact.sha256));
    expect(() =>
      retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output"),
    ).toThrow("symlink");
  });

  it("says nothing was retained where the artifact was not kept", () => {
    const repo = repository();
    const artifact = { ...sealed(repo, "transcript.jsonl", body), retained: false };
    const output = retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output");
    expect(output.transcript).toBeNull();
    expect(output.notes).toEqual([]);
  });

  it("redacts a credential the transcript carried", () => {
    const repo = repository();
    const leaked = 'ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz';
    const artifact = sealed(repo, "transcript.jsonl", leaked);
    named(repo, artifact, leaked);
    const output = retainedOutput(repo, detail([bundle({ artifacts: [artifact] })]), "att_output");
    expect(output.transcript).not.toContain("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz");
  });
});
