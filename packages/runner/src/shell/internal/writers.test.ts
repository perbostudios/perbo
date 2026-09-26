import { describe, expect, it } from "vitest";
import { decision, withoutMapEntry } from "../test-support/pins.js";
import { longCandidates, longOption } from "./command.js";
import { WRITERS, longNames } from "./writers.js";

/**
 * `WRITERS` pins a **decision** (SCP-190). Without the entry the verb is a word
 * the guard has no reading for, and the line it refused is allowed.
 */

/**
 * One line per writer, refused today because the table says where that verb's
 * destination is. Every one lands outside the root; without the entry the verb
 * names nothing the guard resolves.
 */
const WRITER_LINES: Record<string, string> = {
  cp: "cp notes.md ~/backup.md",
  mv: "mv notes.md ~/backup.md",
  rm: "rm -rf ~/scratch",
  chmod: "chmod 777 /etc/hosts",
  chown: "chown me /etc/hosts",
  chgrp: "chgrp staff /etc/hosts",
  tee: "pnpm test | tee ~/log.txt",
  dd: "dd if=notes.md of=~/copy.md",
  install: "install -m 755 run.sh /usr/local/bin/run",
  rsync: "rsync -a src/ ~/backup/",
  scp: "scp notes.md user@host.example.com:/srv/notes.md",
  touch: "touch /etc/marker",
  mkdir: "mkdir -p ~/scratch/deep",
  mkfifo: "mkfifo /tmp/pipe",
  rmdir: "rmdir /tmp/generated",
  unlink: "unlink /tmp/x",
  truncate: "truncate -s 0 /tmp/log",
  sed: "sed -i 's/a/b/' /etc/hosts",
  curl: "curl -o /tmp/payload https://example.com/x",
  wget: "wget -O ~/payload https://example.com/x",
  tar: "tar -czf /tmp/archive.tgz src",
  unzip: "unzip -d /tmp/out archive.zip",
};

describe("every writer in the table, pinned by removing it", () => {
  it("has a line for every entry, and no line for an entry that is gone", () => {
    expect(Object.keys(WRITER_LINES).sort()).toEqual([...WRITERS.keys()].sort());
  });

  for (const [verb, command] of Object.entries(WRITER_LINES)) {
    it(`\`${verb}\`: ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      withoutMapEntry(WRITERS, verb, () => {
        expect(decision(command), `without \`${verb}\`: ${command}`).toBe("allowed");
      });
      expect(decision(command), command).toBe("refused");
    });
  }
});

/**
 * `;` and `+` end a `find -exec` body and nothing else. Anywhere else a quoted
 * `;`, a `+` or a quoted parenthesis is one more operand, and the destination is
 * read past it.
 */
const PAST_A_TERMINATOR = [
  "cp a b + /etc",
  "cp a b ';' /etc",
  "cp a b \\; /etc",
  "cp a b '(' /etc",
  "rm a + /etc/x",
  "ln a + /etc/x",
  "ln -s a ';' /etc/x",
  // Inside a body, `+` ends it only straight after `{}`.
  "find . -exec cp a + /etc/x \\;",
];

/** The same words where they do end a body. */
const AT_A_TERMINATOR = [
  "find . -name x -exec rm {} +",
  "find . -name x -exec cp {} sub \\;",
];

describe("a word that ends a find -exec body", () => {
  for (const command of PAST_A_TERMINATOR) {
    it(`ends nothing in ${command}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of AT_A_TERMINATOR) {
    it(`ends the body in ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});

describe("a long option by any unambiguous prefix, as GNU reads it", () => {
  it("resolves a prefix of exactly one name, and nothing ambiguous or unknown", () => {
    const names = ["--target-directory", "--no-target-directory", "--suffix", "--sparse"];
    expect(longOption("--t", names)).toBe("--target-directory");
    expect(longOption("--target-directory", names)).toBe("--target-directory");
    expect(longOption("--no-t", names)).toBe("--no-target-directory");
    expect(longOption("--s", names)).toBeNull();
    expect(longOption("--su", names)).toBe("--suffix");
    expect(longOption("--x", names)).toBeNull();
    expect(longOption("--", names)).toBeNull();
    // A whole name wins over the longer names it is a prefix of.
    expect(longOption("--backup", ["--backup", "--backup-dir"])).toBe("--backup");
    expect(longCandidates("--s", names)).toEqual(["--suffix", "--sparse"]);
  });

  /** Every writer's destination options, spelled by prefix: each lands outside the root. */
  const ABBREVIATED = [
    "cp --target=/tmp notes.md",
    "cp --t=/tmp notes.md",
    "cp --target /tmp notes.md",
    "mv --targ=/tmp notes.md",
    "install --target-dir=/tmp notes.md",
    "ln -s --target=/tmp notes.md",
    "ln --t /tmp notes.md",
    "sed --in s/a/b/ /etc/hosts",
    "sed --in-pl=.bak s/a/b/ /etc/hosts",
    "pnpm test | tee --output-error ~/log.txt",
    "tar -x --dir=/tmp -f archive.tgz",
    "tar --cr -f /tmp/archive.tgz src",
    "wget --directory-p=/tmp https://example.com/x",
    "chmod --ref=notes.md /etc/hosts",
  ];

  for (const command of ABBREVIATED) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  it("still judges a line that abbreviates as though the prefix were unknown", () => {
    // GNU reads `/tmp/ref` as the value of `--reference` and writes only
    // `notes.md`; a reading that did not resolve the prefix judged `/tmp/ref`
    // as a destination, and that reading still stands beside the other.
    for (const command of ["touch --ref /tmp/ref notes.md", "ln --suf /tmp/x -s a notes.md"]) {
      expect(decision(command), command).toBe("refused");
    }
    expect(decision("touch --reference /tmp/ref notes.md")).toBe("allowed");
  });

  it("reads each long name an entry holds by its prefixes, against every name it holds", () => {
    for (const [verb, spec] of WRITERS) {
      const names = longNames(spec);
      for (const name of names) {
        for (let length = 3; length <= name.length; length += 1) {
          const prefix = name.slice(0, length);
          const others = names.filter((other) => other !== name && other.startsWith(prefix));
          const expected = names.includes(prefix) ? prefix : others.length === 0 ? name : null;
          expect(longOption(prefix, names), `${verb} ${prefix}`).toBe(expected);
        }
      }
    }
  });
});
