import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { judgeCommand } from "../src/admission.js";
import { UNKNOWN_CWD, inspectCommand, inspectCommandWithCwd } from "../src/prohibited.js";
import { scratchPath } from "../src/scratch.js";

/**
 * A push is judged by where its remote goes, not by the word `push`.
 *
 * The runner performs the push to GitHub; the agent never publishes. A push
 * whose remote is a filesystem path inside the attempt's own worktree or its
 * temporary directory publishes nothing — it is how an executor builds a test
 * against a bare fixture — and is the agent's ordinary work. Anything that
 * resolves elsewhere, or cannot be resolved, is still the runner's.
 */

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

const base = realpathSync(mkdtempSync(join(tmpdir(), "perbo-push-")));
const root = join(base, "wt");
const scratch = scratchPath(root);
const elsewhere = join(base, "elsewhere");
mkdirSync(root, { recursive: true });
mkdirSync(scratch, { recursive: true });
mkdirSync(elsewhere, { recursive: true });

/** A bare fixture under the attempt's temporary directory, as the executor made it. */
const fixture = join(scratch, "fixture.git");
git(scratch, "init", "-q", "--bare", fixture);
/** The repository that pushes to it, its `origin` stored as a relative path. */
const probe = join(scratch, "probe", "src");
mkdirSync(probe, { recursive: true });
git(probe, "init", "-q");
git(probe, "remote", "add", "origin", "../../fixture.git");

const repoWithRemote = (name: string, url: string): string => {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", url);
  return dir;
};
const hosted = repoWithRemote("hosted", "https://github.com/x/y.git");
const overSsh = repoWithRemote("over-ssh", "git@github.com:x/y.git");
const outsideBare = join(elsewhere, "outside.git");
git(elsewhere, "init", "-q", "--bare", outsideBare);
const outside = repoWithRemote("outside-remote", outsideBare);
const withToken = repoWithRemote(
  "with-token",
  "https://x-access-token:abc123secret@github.com/x/y.git",
);
const viaFileUrl = repoWithRemote("via-file-url", `file://${fixture}`);
const withScpToken = repoWithRemote("with-scp-token", "deploy:abc123secret@github.com:x/y.git");

/** `origin` fetches from the local fixture and pushes to GitHub: the push URL is the one that counts. */
const pushesElsewhere = repoWithRemote("pushes-elsewhere", "../fixture.git");
git(pushesElsewhere, "remote", "set-url", "--push", "origin", "https://github.com/x/y.git");
/** The reverse: fetches from GitHub, pushes into the fixture. */
const pushesHome = repoWithRemote("pushes-home", "https://github.com/x/y.git");
git(pushesHome, "remote", "set-url", "--push", "origin", fixture);
/** A directory named like the remote, beside a remote that goes to GitHub. */
const shadowed = repoWithRemote("shadowed", "https://github.com/x/y.git");
mkdirSync(join(shadowed, "origin"), { recursive: true });

/** A remote that is a transport git runs, not a place. */
const extTransport = repoWithRemote("ext-transport", "ext::sh -c 'cat >/dev/null'");
/** A remote whose path does not exist. */
const gone = repoWithRemote("gone", join(scratch, "gone.git"));
/**
 * A remote written relative to the repository's top level that leaves the
 * attempt's directories — and a decoy where reading it against a subdirectory
 * instead would land, inside them.
 */
const outsideByRelativePath = repoWithRemote("outside-rel", "../../../elsewhere/outside.git");
mkdirSync(join(outsideByRelativePath, "sub"), { recursive: true });
git(root, "init", "-q", "--bare", join(root, "elsewhere", "outside.git"));
mkdirSync(join(probe, "sub"), { recursive: true });

/** Configured to push its submodules along, with a local remote of its own. */
const recursing = repoWithRemote("recursing", "../fixture.git");
git(recursing, "config", "push.recurseSubmodules", "on-demand");

const pushes = (command: string, cwd: string) =>
  inspectCommandWithCwd(command, { root, tmpdir: scratch, cwd }).hits.filter(
    (hit) => hit.action === "destructive_git",
  );

describe("a push to a remote inside the attempt's own scratch", () => {
  it("is permitted from inside the repository, its origin a relative path", () => {
    expect(pushes("git push origin develop", probe)).toEqual([]);
  });

  it("is permitted through `-C` from the worktree root, the recorded case's shape", () => {
    expect(pushes("git -C .perbo-tmp/probe/src push -q origin develop", root)).toEqual([]);
  });

  it("is permitted through `-C` relative to the shell's directory", () => {
    expect(pushes("git -C probe/src push -q origin develop", scratch)).toEqual([]);
  });

  it("is permitted when the remote is a `file://` URL to the fixture", () => {
    expect(pushes("git push origin develop", viaFileUrl)).toEqual([]);
  });

  it("is permitted when the remote is written as the path itself", () => {
    expect(pushes(`git push ${fixture} develop`, probe)).toEqual([]);
    expect(pushes("git push ../../fixture.git develop", probe)).toEqual([]);
  });

  it("is permitted where the shell moved earlier on the line, whatever follows the push", () => {
    expect(pushes("cd .perbo-tmp/probe/src && git push origin develop && echo done", root)).toEqual([]);
    expect(pushes("cd .perbo-tmp/probe/src; git push origin develop; echo done", root)).toEqual([]);
    expect(pushes("git -C .perbo-tmp/probe/src push origin develop && git log --oneline -1", root)).toEqual([]);
  });

  it("is permitted across a line continuation", () => {
    expect(pushes("git push \\\n  origin develop", probe)).toEqual([]);
  });

  it("is permitted from a subdirectory: a relative remote is read against the repository's top level", () => {
    expect(pushes("git push origin develop", join(probe, "sub"))).toEqual([]);
  });

  it("is permitted with submodule recursion switched off on the command line", () => {
    expect(pushes("git push --recurse-submodules=no origin develop", probe)).toEqual([]);
    expect(pushes("git push --recurse-submodules=check origin develop", probe)).toEqual([]);
  });

  it("is permitted where the remote fetches from GitHub but pushes into the fixture", () => {
    expect(pushes("git push origin develop", pushesHome)).toEqual([]);
  });

  it("through the hook's judgement as well", () => {
    const { admission, inspection } = judgeCommand({
      tool: "Bash",
      detail: "git push origin develop",
      allow_list: [],
      deny_list: [],
      scope: { root, tmpdir: scratch, cwd: probe },
    });
    expect(admission.decision).toBe("allowed");
    expect(inspection.hits.filter((hit) => hit.action === "destructive_git")).toEqual([]);
  });
});

describe("a push the runner still performs", () => {
  it("to an https remote, naming the URL git itself would push to", () => {
    // The machine's own git configuration may rewrite the URL (`insteadOf`);
    // what the refusal names is where the push would have gone.
    const effective = execFileSync("git", ["-C", hosted, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    const [hit] = pushes("git push origin main", hosted);
    expect(hit?.detail).toContain(effective);
    expect(hit?.detail).toContain("a URL");
    expect(hit?.detail).toContain("git push origin main");
  });

  it("to an ssh remote, naming the URL", () => {
    const [hit] = pushes("git push origin main", overSsh);
    expect(hit?.detail).toContain("git@github.com:x/y.git");
    expect(hit?.detail).toContain("a URL");
  });

  it("to a path outside the worktree and the temporary directory, naming the path", () => {
    const [hit] = pushes("git push origin main", outside);
    expect(hit?.detail).toContain(outsideBare);
    expect(hit?.detail).toContain("outside the worktree");
  });

  it("where the remote pushes to GitHub whatever it fetches from", () => {
    const effective = execFileSync(
      "git",
      ["-C", pushesElsewhere, "remote", "get-url", "--push", "origin"],
      { encoding: "utf8" },
    ).trim();
    const [hit] = pushes("git push origin develop", pushesElsewhere);
    expect(hit?.detail).toContain(effective);
    expect(hit?.detail).toContain("a URL");
  });

  it("where a directory named like the remote stands beside it: git's remote wins, as it does for git", () => {
    const [hit] = pushes("git push origin main", shadowed);
    expect(hit?.detail).toContain("a URL");
  });

  it("where `--git-dir` addresses a repository whose remote goes to GitHub", () => {
    const gitDir = join(hosted, ".git");
    expect(pushes(`git --git-dir=${gitDir} push origin main`, probe).map((hit) => hit.action)).toEqual([
      "destructive_git",
    ]);
    expect(pushes(`git --git-dir ${gitDir} push origin main`, probe).map((hit) => hit.action)).toEqual([
      "destructive_git",
    ]);
  });

  it("where `-c` rewrites the push URL on the command line", () => {
    const [hit] = pushes(
      "git -c remote.origin.pushurl=https://github.com/x/y.git push origin develop",
      probe,
    );
    expect(hit?.detail).toContain("https://github.com/x/y.git");
  });

  it("where the environment redirects git to another repository", () => {
    const [hit] = pushes(`GIT_DIR=${join(hosted, ".git")} git push origin develop`, probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("GIT_DIR");
  });

  it("where a subshell moves the shell inside the segment", () => {
    const [hit] = pushes(`(cd ${hosted} && git push origin main)`, probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("not the first command");
  });

  it("where an assignment before git changes what it reads", () => {
    const [hit] = pushes("HOME=/nonexistent git push origin develop", probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("HOME");
  });

  it("where the remote is a transport git runs", () => {
    const [hit] = pushes("git push origin develop", extTransport);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("ext::");
    expect(hit?.detail).toContain("a URL");
  });

  it("from a subdirectory whose relative remote leaves the attempt's directories, whatever a shallower reading would find", () => {
    const [hit] = pushes("git push origin main", join(outsideByRelativePath, "sub"));
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain(outsideBare);
    expect(hit?.detail).toContain("outside the worktree");
  });

  it("where a wrapper carries an option", () => {
    const [hit] = pushes("env -i git push origin develop", probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("not the first command");
  });

  it("where the remote's path does not exist", () => {
    const [hit] = pushes("git push origin develop", gone);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("does not exist");
  });

  it("where git cannot be asked, even for a path that would be local", () => {
    const path = process.env.PATH;
    process.env.PATH = join(base, "no-git-here");
    try {
      const [hit] = pushes("git push ../../fixture.git develop", probe);
      expect(hit?.action).toBe("destructive_git");
      expect(hit?.detail).toContain("could not be asked");
    } finally {
      process.env.PATH = path;
    }
  });

  it("where anything but a move of the shell to a literal path stands before it on the line", () => {
    for (const line of [
      "git config remote.origin.pushurl https://github.com/x/y.git && git push origin develop",
      "git remote set-url origin https://github.com/x/y.git; git push origin develop",
      "printf x > .git/config && git push origin develop",
      "cd .git && cp /dev/null config && git -C .. push origin develop",
      "mkdir scratch-dir && git push origin develop",
      "git commit --allow-empty -m x && git push origin develop",
      "install -m 644 /dev/null .git/config && git push origin develop",
      "tar -xf nothing.tar && git push origin develop",
      "patch -p1 < fix.diff && git push origin develop",
      "./rewrite.sh && git push origin develop",
      "python3 rewrite.py && git push origin develop",
      "make && git push origin develop",
      "sh -c 'true' && git push origin develop",
      "echo $(cp /dev/null .git/config) && git push origin develop",
      "echo `cp /dev/null .git/config` && git push origin develop",
      "./ls && git push origin develop",
      "/bin/echo x && git push origin develop",
      "cat README.md; git push origin develop",
      "echo starting && git push origin develop",
      "test -d sub && git push origin develop",
      "ls -la && git push origin develop",
      "cd sub dir && git push origin develop",
    ]) {
      const [hit] = pushes(line, probe);
      expect(hit?.action, line).toBe("destructive_git");
      expect(hit?.detail, line).toContain("own command");
    }
    // A substitution in the move itself leaves the shell's directory unread,
    // which refuses the push before the rule above is asked.
    const [moved] = pushes("cd $(cp /dev/null .git/config) && git push origin develop", probe);
    expect(moved?.action).toBe("destructive_git");
  });

  it("is judged where only a move of the shell to a literal path stands before it, and whatever follows", () => {
    for (const line of [
      "cd sub && git -C .. push origin develop",
      "cd ./sub; git -C .. push origin develop",
      "ls && git push origin develop",
      "pwd && git push origin develop",
      "true && git push origin develop",
      "git push origin develop && git config --get remote.origin.url",
      "git push origin develop; mkdir after",
      "git push origin develop && echo $(cat .git/config)",
    ]) {
      expect(pushes(line, probe), line).toEqual([]);
    }
  });

  it("reads an option wherever it stands, after the remote and the refspec too", () => {
    const [hit] = pushes("git -C . push origin develop --recurse-submodules=on-demand", probe);
    expect(hit?.detail).toContain("submodules");
    expect(pushes("git push origin develop --recurse-submodules=no", probe)).toEqual([]);
    // `--repo` names the remote only where no positional word does, as for git.
    expect(pushes("git push --repo=https://github.com/x/y.git", probe)[0]?.detail).toContain("a URL");
    expect(pushes("git push --repo=https://github.com/x/y.git origin develop", probe)).toEqual([]);
  });

  it("where the push recurses into submodules by its flag", () => {
    const [hit] = pushes("git push --recurse-submodules=on-demand origin develop", probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("submodules");
    expect(pushes("git push --recurse-submodules origin develop", probe)[0]?.detail).toContain("submodules");
  });

  it("where the push recurses into submodules by the repository's configuration", () => {
    const [hit] = pushes("git push origin develop", recursing);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("submodules");
  });

  it("names the URL without the credential the remote carries", () => {
    const [hit] = pushes("git push origin main", withToken);
    expect(hit?.detail).toContain("https://github.com/x/y.git");
    expect(hit?.detail).not.toContain("abc123secret");
  });

  it("names the scp-like spelling without the credential it carries", () => {
    const [hit] = pushes("git push origin main", withScpToken);
    expect(hit?.detail).toContain("github.com:x/y.git");
    expect(hit?.detail).not.toContain("abc123secret");
    expect(hit?.detail).not.toContain("deploy");
  });

  it("names a transport by its scheme, never by the command after it", () => {
    const [hit] = pushes("git push origin develop", extTransport);
    expect(hit?.detail).toContain("ext::");
    expect(hit?.detail).not.toContain("cat");
  });

  it("where the remote does not exist", () => {
    const [hit] = pushes("git push upstream main", probe);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("upstream");
  });

  it("where no remote is named, so the push goes to the branch's upstream", () => {
    const [hit] = pushes("git push", probe);
    expect(hit?.action).toBe("destructive_git");
  });

  it("where the shell's directory is unknown", () => {
    const [hit] = pushes("git push origin develop", UNKNOWN_CWD);
    expect(hit?.action).toBe("destructive_git");
    expect(hit?.detail).toContain("unknown");
  });

  it("where the caller named no worktree at all", () => {
    expect(inspectCommand("git push origin develop").map((hit) => hit.action)).toEqual([
      "destructive_git",
    ]);
  });

  it("with `--force`, even to the local fixture", () => {
    const hits = pushes("git push --force origin develop", probe);
    expect(hits.map((hit) => hit.detail).join("\n")).toContain("force-push");
  });

  it("with `--delete`, even to the local fixture", () => {
    const hits = pushes("git push origin --delete develop", probe);
    expect(hits.map((hit) => hit.detail).join("\n")).toContain("branch deletion by push");
  });

  it("through the hook's judgement as well", () => {
    const { inspection } = judgeCommand({
      tool: "Bash",
      detail: "git push origin main",
      allow_list: [],
      deny_list: [],
      scope: { root, tmpdir: scratch, cwd: hosted },
    });
    expect(inspection.hits.map((hit) => hit.action)).toContain("destructive_git");
  });
});
