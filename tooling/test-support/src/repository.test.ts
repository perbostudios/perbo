import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitEnvironment, initBareRepository, initRepository } from "./repository.js";
import { scratchDirectories } from "./scratch.js";

const scratch = scratchDirectories("perbo-repository-test-");

/** Set environment variables for one test, whatever it does on the way out. */
function withEnvironment(values: Readonly<Record<string, string>>, body: () => void): void {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("gitEnvironment", () => {
  it("reads PATH when it is called, so a binary a test has just faked is found", () => {
    const fakeBin = scratch("perbo-fake-bin-");
    withEnvironment({ PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` }, () => {
      expect(gitEnvironment()["PATH"]?.startsWith(`${fakeBin}:`)).toBe(true);
    });
  });

  it("carries nothing else from the process", () => {
    withEnvironment(
      { GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "/elsewhere/idx" },
      () => {
        const environment = gitEnvironment();
        expect(environment["GIT_DIR"]).toBeUndefined();
        expect(environment["GIT_WORK_TREE"]).toBeUndefined();
        expect(environment["GIT_INDEX_FILE"]).toBeUndefined();
        expect(environment["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
        expect(environment["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
        expect(environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
        expect(environment["GIT_AUTHOR_EMAIL"]).toBe("test@example.com");
      },
    );
  });

  it("puts what the caller adds on top", () => {
    expect(gitEnvironment({ GIT_CONFIG_GLOBAL: "/tmp/theirs" })["GIT_CONFIG_GLOBAL"]).toBe(
      "/tmp/theirs",
    );
  });
});

describe("initRepository", () => {
  it("initialises the directory it was given, not the one the environment names", () => {
    const elsewhere = initRepository(join(scratch(), "elsewhere"), {
      files: { "theirs.txt": "theirs\n" },
    });
    const untouched = {
      head: elsewhere.git("rev-parse", "HEAD").trim(),
      index: elsewhere.git("ls-files").trim(),
    };
    const dir = join(scratch(), "mine");

    withEnvironment(
      {
        GIT_DIR: join(elsewhere.dir, ".git"),
        GIT_WORK_TREE: elsewhere.dir,
        GIT_INDEX_FILE: join(elsewhere.dir, ".git", "index"),
      },
      () => {
        const repository = initRepository(dir, { files: { "mine.txt": "mine\n" } });
        expect(realpathSync(repository.git("rev-parse", "--show-toplevel").trim())).toBe(
          realpathSync(dir),
        );
        expect(repository.git("ls-files").trim()).toBe("mine.txt");
      },
    );

    expect(elsewhere.git("rev-parse", "HEAD").trim()).toBe(untouched.head);
    expect(elsewhere.git("ls-files").trim()).toBe(untouched.index);
  });

  // Both signing formats, because the local `commit.gpgsign false` is what
  // decides before the format is ever consulted — and because on a machine
  // that signs over SSH the real symptom is the commit hanging on a key this
  // process cannot unlock, which a test cannot wait for.
  it.each([
    ["openpgp", (signer: string) => `[gpg]\n\tprogram = ${signer}\n`],
    [
      "ssh",
      (signer: string) =>
        `[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = ${signer}\n[user]\n\tsigningkey = key\n`,
    ],
  ])("lets product code commit on a machine whose global configuration signs over %s", (
    format,
    signing,
  ) => {
    const root = scratch(`perbo-signing-${format}-`);
    const refuse = join(root, "refuse-to-sign");
    writeFileSync(refuse, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const globalConfig = join(root, "gitconfig");
    writeFileSync(globalConfig, `[commit]\n\tgpgsign = true\n${signing(refuse)}`);

    const repository = initRepository(join(root, "repository"));
    // How the product runs git: the person's environment, saying nothing about
    // who is committing or whether to sign. Both answers have to be in the
    // repository, or this fails inside product code rather than in a test.
    const committed = spawnSync("git", ["-C", repository.dir, "commit", "--allow-empty", "-m", "x"], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });

    expect(`${committed.status} ${committed.stderr}`).toBe("0 ");
    // And it is by the fixture identity, not by whoever git guessed from the
    // machine's username and hostname, which is what it falls back to.
    expect(repository.git("log", "-1", "--format=%an <%ae>").trim()).toBe("test <test@example.com>");
  });

  it("puts the first commit on main whatever branch the machine defaults to", () => {
    const root = scratch("perbo-branch-");
    const globalConfig = join(root, "gitconfig");
    writeFileSync(globalConfig, "[init]\n\tdefaultBranch = trunk\n");

    withEnvironment({ GIT_CONFIG_GLOBAL: globalConfig }, () => {
      const byDefault = initRepository(join(root, "default"));
      expect(byDefault.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
      const named = initRepository(join(root, "named"), { branch: "release" });
      expect(named.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("release");
    });
  });

  it("commits an empty tree when there is nothing to put in it", () => {
    const repository = initRepository(join(scratch(), "empty"));
    expect(repository.git("ls-files").trim()).toBe("");
    expect(repository.head).toBe(repository.git("rev-parse", "HEAD").trim());
    expect(repository.git("log", "--format=%s").trim()).toBe("base");
  });

  it("writes the files it is given, making the directories they need", () => {
    const repository = initRepository(join(scratch(), "files"), {
      files: { "src/deep/a.ts": "export const a = 1;\n", "README.md": "# fixture\n" },
      message: "first",
    });
    expect(repository.git("ls-files").trim().split("\n").sort()).toEqual([
      "README.md",
      "src/deep/a.ts",
    ]);
    expect(readFileSync(join(repository.dir, "src", "deep", "a.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(repository.git("log", "--format=%s").trim()).toBe("first");
  });

  it("copies a working tree in, and the files it is given win a collision", () => {
    const source = scratch("perbo-source-");
    mkdirSync(join(source, "docs"), { recursive: true });
    writeFileSync(join(source, "docs", "guide.md"), "from the copy\n");
    writeFileSync(join(source, "shared.txt"), "from the copy\n");

    const repository = initRepository(join(scratch(), "copied"), {
      copyFrom: source,
      files: { "shared.txt": "from the files\n" },
    });
    expect(repository.git("ls-files").trim().split("\n").sort()).toEqual([
      "docs/guide.md",
      "shared.txt",
    ]);
    expect(readFileSync(join(repository.dir, "shared.txt"), "utf8")).toBe("from the files\n");
  });

  it("accepts a directory that already has something in it", () => {
    const dir = join(scratch(), "already");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "there.txt"), "there\n");
    expect(initRepository(dir).git("ls-files").trim()).toBe("there.txt");
  });

  it("sets the configuration the caller asks for", () => {
    const repository = initRepository(join(scratch(), "configured"), {
      config: { "core.ignorecase": "false" },
    });
    expect(repository.git("config", "core.ignorecase").trim()).toBe("false");
  });
});

describe("Repository.commit", () => {
  it("dates the commit when the caller says when", () => {
    const repository = initRepository(join(scratch(), "dated"));
    const at = "2026-03-04T05:06:07Z";
    const head = repository.commit({ "a.txt": "a\n" }, "second", { at });

    expect(head).toBe(repository.git("rev-parse", "HEAD").trim());
    expect(head).not.toBe(repository.head);
    const seconds = String(Date.parse(at) / 1000);
    expect(repository.git("log", "-1", "--format=%at").trim()).toBe(seconds);
    expect(repository.git("log", "-1", "--format=%ct").trim()).toBe(seconds);
    expect(repository.git("log", "-1", "--format=%aI").trim()).toContain("2026-03-04T05:06:07");
  });

  it("commits nothing when there is nothing to commit", () => {
    const repository = initRepository(join(scratch(), "again"));
    const head = repository.commit({}, "nothing");

    expect(head).not.toBe(repository.head);
    expect(repository.git("log", "--format=%s").trim().split("\n")).toEqual(["nothing", "base"]);
    expect(repository.git("ls-files").trim()).toBe("");
  });
});

describe("initBareRepository", () => {
  it("takes a push from a repository", () => {
    const bare = initBareRepository(join(scratch(), "origin.git"));
    const repository = initRepository(join(scratch(), "clone"), { files: { "a.txt": "a\n" } });

    repository.git("push", "-q", bare, "main");

    expect(repository.git("ls-remote", bare, "refs/heads/main")).toContain(repository.head);
  });

  it("points HEAD at the branch it was given", () => {
    const bare = initBareRepository(join(scratch(), "trunk.git"), { branch: "trunk" });

    // A repository with no refs yet answers `ls-remote` with nothing at all,
    // symrefs included, so what HEAD points at is asked of the repository.
    const head = execFileSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD"], {
      encoding: "utf8",
      env: gitEnvironment(),
    });

    expect(head.trim()).toBe("refs/heads/trunk");
  });
});

