import { describe, expect, it } from "vitest";
import { decision, withoutMapEntry } from "../test-support/pins.js";
import { WRITERS } from "./writers.js";

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
