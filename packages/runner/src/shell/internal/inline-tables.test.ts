import { describe, expect, it } from "vitest";
import { decision, sentence, withoutListEntry } from "../test-support/pins.js";
import { INLINE_READ_ONLY, INLINE_WRITE_CALLS, PLAIN_WRITE_CALLS } from "./inline-tables.js";

/**
 * The inline-program tables, each entry pinned by removing it (SCP-190).
 *
 * - `INLINE_READ_ONLY` pins a decision: without the entry the shape is no
 *   longer one the guard can show writes nothing, and an allowed line is
 *   refused.
 * - `INLINE_WRITE_CALLS` pins a **sentence**. Since SCP-190 those entries no
 *   longer decide anything — the allow-list refuses the code with or without
 *   them — so what is lost when one goes is the refusal an agent can act on,
 *   and that is what is asserted.
 * - `PLAIN_WRITE_CALLS` pins a decision the same way `INLINE_READ_ONLY` does
 *   (SCP-234): without the entry the call is a name the read-only table cannot
 *   vouch for, and a write to a literal path inside the worktree is refused.
 */

/**
 * One line per read-only shape, allowed today because the table names the shape
 * it is written in. Without the entry the guard can no longer show the code
 * writes nothing, and refuses it — which is the whole reading, inverted.
 */
const READ_ONLY_LINES: Record<string, string> = {
  printing: `python3 -c "print(1)"`,
  "arithmetic-and-strings": `python3 -c "print(len('abc'))"`,
  json: `node -e "console.log(JSON.stringify({a: 1}))"`,
  "file-read": `python3 -c "print(open('package.json').read())"`,
  environment: `node -e "console.log(process.version)"`,
  imports: `python3 -c "import sys"`,
  binding: `node -e "const x = 1; console.log(x)"`,
  "control-flow": ["python3 <<'PY'", "for i in [1, 2]:", "    print(i)", "PY"].join("\n"),
};

/**
 * One line per plain write call: allowed today because the table says the call
 * names its destination, and that destination is inside the root. Without the
 * entry the call is a name the read-only table does not carry, and the line is
 * refused for the shape rather than for where it writes.
 */
const PLAIN_WRITE_LINES: Record<string, string> = {
  "open-write": `python3 -c "open('notes.md','w')"`,
  "write-file-sync": `node -e "writeFileSync('notes.md','x')"`,
  "path-write-text": `python3 -c "import pathlib; pathlib.Path('notes.md').write_text('x')"`,
};

/**
 * One line per write-call sentence: refused either way, and the reason it gives
 * is the entry's. Each is the first entry that matches its line, which is what
 * decides the sentence printed.
 *
 * The sentence is written out here rather than read off the table, so that
 * taking an entry out of the table fails an assertion in this file rather than
 * a lookup at the top of it — a suite that will not load is a worse record of
 * what broke than a suite that says which line changed its answer.
 */
const WRITE_CALL_LINES: Record<string, { line: string; detail: string }> = {
  // The destination is a name rather than a literal, which is the shape whose
  // refusal these sentences are still for: a write the guard cannot place
  // (SCP-234). A literal path inside the worktree is admitted and says nothing.
  "write-file": { line: `node -e "fs.writeFileSync(target,'x')"`, detail: "writes a file" },
  "stream-write": {
    line: `ruby -e "File.write('x','y')"`,
    detail: "writes to a stream it opened",
  },
  "open-for-writing": {
    line: `python3 -c "open(target,'w')"`,
    detail: "opens a file for writing",
  },
  "filesystem-call": {
    line: `python3 -c "os.unlink('x')"`,
    detail: "changes the filesystem",
  },
  spawn: { line: `python3 -c "os.system('ls')"`, detail: "spawns a process of its own" },
  "load-fs-module": {
    line: `node -e "const fs = require('fs')"`,
    detail: "loads the filesystem or process library",
  },
  "import-fs-module": {
    line: `python3 -c "import shutil"`,
    detail: "imports the filesystem or process library",
  },
  "awk-redirect": {
    line: `awk '{print > "x"}' src/index.ts`,
    detail: "redirects its output to a file",
  },
};

describe("every read-only shape, pinned by removing it", () => {
  it("has a line for every entry, and no line for an entry that is gone", () => {
    expect(Object.keys(READ_ONLY_LINES).sort()).toEqual(
      INLINE_READ_ONLY.map((rule) => rule.id).sort(),
    );
  });

  it("gives every entry a reason, which is what the table is for", () => {
    for (const rule of INLINE_READ_ONLY) {
      expect(rule.reason.length, rule.id).toBeGreaterThan(20);
    }
  });

  for (const [id, command] of Object.entries(READ_ONLY_LINES)) {
    it(`\`${id}\`: ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
      const index = INLINE_READ_ONLY.findIndex((rule) => rule.id === id);
      withoutListEntry(INLINE_READ_ONLY, index, () => {
        expect(decision(command), `without \`${id}\`: ${command}`).toBe("refused");
      });
      expect(decision(command), command).toBe("allowed");
    });
  }
});

describe("every plain write call, pinned by removing it", () => {
  it("has a line for every entry, and no line for an entry that is gone", () => {
    expect(Object.keys(PLAIN_WRITE_LINES).sort()).toEqual(
      PLAIN_WRITE_CALLS.map((rule) => rule.id).sort(),
    );
  });

  it("gives every entry a reason, which is what the table is for", () => {
    for (const rule of PLAIN_WRITE_CALLS) {
      expect(rule.reason.length, rule.id).toBeGreaterThan(20);
    }
  });

  for (const [id, command] of Object.entries(PLAIN_WRITE_LINES)) {
    it(`\`${id}\`: ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
      const index = PLAIN_WRITE_CALLS.findIndex((rule) => rule.id === id);
      withoutListEntry(PLAIN_WRITE_CALLS, index, () => {
        expect(decision(command), `without \`${id}\`: ${command}`).toBe("refused");
      });
      expect(decision(command), command).toBe("allowed");
    });
  }
});

describe("every write-call sentence, pinned by removing it", () => {
  it("has a line for every entry, saying the sentence that entry carries", () => {
    expect(Object.keys(WRITE_CALL_LINES).sort()).toEqual(
      INLINE_WRITE_CALLS.map((rule) => rule.id).sort(),
    );
    for (const rule of INLINE_WRITE_CALLS) {
      expect(WRITE_CALL_LINES[rule.id]?.detail, rule.id).toBe(rule.detail);
    }
  });

  for (const [id, { line: command, detail }] of Object.entries(WRITE_CALL_LINES)) {
    it(`\`${id}\` says "${detail}": ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain(detail);
      const index = INLINE_WRITE_CALLS.findIndex((rule) => rule.id === id);
      expect(index, id).toBeGreaterThanOrEqual(0);
      withoutListEntry(INLINE_WRITE_CALLS, index, () => {
        // Still refused — the allow-list is what decides — but the record no
        // longer says which call earned it.
        expect(decision(command), `without \`${id}\`: ${command}`).toBe("refused");
        expect(sentence(command), `without \`${id}\`: ${command}`).not.toContain(detail);
      });
      expect(sentence(command), command).toContain(detail);
    });
  }
});

/**
 * The mirror of every pin above.
 *
 * The pins prove each entry present today earns its place. They cannot prove
 * anything about the entry somebody adds next year — and the whole reading now
 * rests on one property of `INLINE_READ_ONLY`, which is that nothing in its
 * vocabulary reaches the filesystem, a process or the network. A single
 * plausible-looking addition (`os.replace` beside `os.path.join`, `copy` beside
 * `concat`) would restore the hole SCP-190 closed, and every pin above would
 * still pass, because a wider allow-list refuses fewer lines rather than more.
 *
 * So the vocabulary is read against a list of words that write. The match is on
 * a **whole segment** of a dotted name, or on a method name entire: `re.sub`
 * stays allowed because `sub` is not one of these words, and `os.remove` trips
 * on `remove` however it is spelled around.
 */
const WRITER_VOCABULARY = [
  "remove", "unlink", "rmdir", "rmtree", "mkdir", "makedirs", "rename", "replace",
  "move", "copy", "write", "append", "truncate", "chmod", "chown", "symlink", "link",
  "delete", "system", "exec", "spawn", "popen", "fork", "kill", "fetch", "request",
  "connect", "send", "eval",
] as const;

/**
 * The one exception, named rather than tolerated.
 *
 * These four end in `write` and are on the list anyway, because what they write
 * to is a stream the guard has always exempted (`INLINE_STREAM_WRITES`) and not
 * a file. The set is asserted to be **exactly** what trips, so a fifth name
 * cannot join it by looking similar — it fails here and has to argue its case.
 */
const STREAM_WRITES = [
  "process.stdout.write",
  "process.stderr.write",
  "sys.stdout.write",
  "sys.stderr.write",
];

describe("the read-only vocabulary reaches nothing that writes", () => {
  const words = new Set<string>(WRITER_VOCABULARY);

  /** Every name the table admits, with the entry and field it came from. */
  const vocabulary = INLINE_READ_ONLY.flatMap((rule) =>
    (["calls", "methods", "names", "modules"] as const).flatMap((field) =>
      (rule[field] ?? []).map((name) => ({ id: rule.id, field, name })),
    ),
  );

  it("reads a vocabulary at all, so a silent empty table cannot pass this file", () => {
    expect(vocabulary.length).toBeGreaterThan(100);
  });

  it("names nothing that writes, spawns or reaches the network", () => {
    const offending = vocabulary
      .filter(({ name }) => !STREAM_WRITES.includes(name))
      .filter(({ name }) => name.split(".").some((segment) => words.has(segment)))
      .map(({ id, field, name }) => `${id}.${field}: ${name}`);
    expect(offending, "a read-only entry names something that writes").toEqual([]);
  });

  it("exempts the stream writers and nothing else", () => {
    const tripping = vocabulary
      .filter(({ name }) => name.split(".").some((segment) => words.has(segment)))
      .map(({ name }) => name);
    expect([...new Set(tripping)].sort()).toEqual([...STREAM_WRITES].sort());
  });

  it("matches whole segments, so `re.sub` passes and `os.remove` does not", () => {
    const trips = (name: string) => name.split(".").some((segment) => words.has(segment));
    expect(trips("re.sub")).toBe(false);
    expect(trips("os.path.join")).toBe(false);
    expect(trips("json.dumps")).toBe(false);
    expect(trips("os.remove")).toBe(true);
    expect(trips("os.replace")).toBe(true);
    expect(trips("shutil.move")).toBe(true);
    expect(trips("FileUtils.rm_rf.delete")).toBe(true);
    expect(trips("remove")).toBe(true);
  });
});
