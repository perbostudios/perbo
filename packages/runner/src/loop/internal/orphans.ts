import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { run } from "@perbo/workspace";

/**
 * What an attempt leaves running, and ending it before the worktree goes.
 *
 * The executor runs in its own process group and the group is signalled when
 * the attempt is terminated; every check runs the same way. A process that
 * called `setsid(2)` leads a session of its own and is in none of those groups,
 * which is what a coding agent's background tasks do — so it survives the
 * termination, survives the worktree being removed underneath it, and goes on
 * holding CPU with `launchd` for a parent (SCP-263: one was found six days
 * later at ten percent of a core).
 *
 * Reaching it needs a different question from "what did I start": every process
 * on the host is asked where it is running from, and the ones running from
 * inside this worktree are ended.
 */

/** A process the sweep ended, as the attempt records it. */
export interface SweptProcess {
  pid: number;
  command: string;
}

/** How long a signalled process has to leave before it is killed. */
export const SWEEP_ESCALATION_MS = 2_000;

/** How long the platform's process listing may take before the sweep gives up on it. */
const LISTING_TIMEOUT_MS = 15_000;

/** How often the escalation window is checked, so an ordinary sweep does not sit out the whole of it. */
const SETTLE_INTERVAL_MS = 50;

/**
 * How much of a listing is read.
 *
 * `lsof` for one descriptor pair on a developer's laptop is several megabytes,
 * and the default cap keeps the tail — which drops the earlier half of the
 * process table and makes finding a survivor depend on where in that table it
 * happened to land.
 */
const LISTING_MAX_BYTES = 64 * 1024 * 1024;

/** Commands named in the progress line, and how much of each. */
const NAMED_IN_PROGRESS = 5;
const COMMAND_CHARS = 120;

interface RunningProcess {
  pid: number;
  ppid: number;
  command: string;
  /** What anchors it to a directory: its current directory and its open executable. */
  paths: string[];
}

/** `ps` and `lsof` are read for their own output; nothing of the attempt's reaches them. */
const listingEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: `${process.env.PATH ?? ""}:/usr/sbin:/sbin:/usr/bin:/bin`,
  LC_ALL: "C",
});

/**
 * Every process on the host, with its parent, its command line and the paths
 * that anchor it.
 *
 * The platform switch is here and nowhere else.
 *
 * Linux answers out of `/proc` and starts nothing: `cwd` and `exe` are links,
 * `cmdline` is the argv, and `stat` carries the parent. Entries that vanish
 * mid-scan or belong to another user are skipped — a process this one may not
 * read is not one it may signal either.
 *
 * macOS has no `/proc`. `ps` gives the parents and the command lines, and
 * `lsof` restricted to the two descriptors — `cwd` and `txt` — gives the paths
 * without descending any directory, which `+D` would. A `lsof` that is missing
 * or does not answer leaves the command lines, which is less than the whole
 * answer and better than none; the listing is read from `/` so neither
 * command's own directory can match a worktree.
 */
async function processTable(): Promise<RunningProcess[]> {
  if (process.platform === "linux") {
    const table: RunningProcess[] = [];
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // The executable name in `stat` is parenthesised and may itself hold
        // spaces and brackets, so the fields are read from after its last `)`.
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        const command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .replace(/\0+$/, "")
          .split("\0")
          .join(" ");
        table.push({
          pid,
          ppid: Number(fields[1] ?? 0),
          command,
          paths: [linkOf(`/proc/${pid}/cwd`), linkOf(`/proc/${pid}/exe`)].filter(
            (path): path is string => path !== null,
          ),
        });
      } catch {
        // Gone between the listing and the read, or another user's.
      }
    }
    return table;
  }

  const table = new Map<number, RunningProcess>();
  const listed = await quietly(["ps", "-axwwo", "pid=,ppid=,command="]);
  for (const line of listed.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (fields === null) continue;
    table.set(Number(fields[1]), {
      pid: Number(fields[1]),
      ppid: Number(fields[2]),
      command: fields[3] ?? "",
      paths: [],
    });
  }
  // `-F pn` is lsof's field output: `p` starts a process, `n` names a path.
  const open = await quietly(["lsof", "-n", "-P", "-w", "-F", "pn", "-d", "cwd,txt"]);
  let at: RunningProcess | undefined;
  for (const line of open.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      at = table.get(pid);
      if (at === undefined && Number.isInteger(pid) && pid > 0) {
        at = { pid, ppid: 0, command: "", paths: [] };
        table.set(pid, at);
      }
    } else if (line.startsWith("n") && at !== undefined) {
      at.paths.push(line.slice(1));
    }
  }
  return [...table.values()];
}

/** A link's target, or null where it cannot be read. */
function linkOf(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** A listing command's stdout, or nothing where it is missing, fails or hangs. */
async function quietly(argv: string[]): Promise<string> {
  try {
    const result = await run(argv, {
      cwd: sep,
      env: listingEnvironment(),
      timeoutMs: LISTING_TIMEOUT_MS,
      maxOutputBytes: LISTING_MAX_BYTES,
    });
    return result.stdout;
  } catch {
    // Not installed, or refused to start. The other half of the listing stands.
    return "";
  }
}

/** Whether a path is the worktree or lies inside it. */
const under = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

/**
 * Whether a command line names the worktree.
 *
 * The character after the match has to end the path, so a worktree at
 * `…/att_0001` is not found in a command naming `…/att_00017`.
 */
function mentions(command: string, root: string): boolean {
  for (let from = command.indexOf(root); from !== -1; from = command.indexOf(root, from + 1)) {
    const after = command.charAt(from + root.length);
    if (after === "" || !/[\w.-]/.test(after)) return true;
  }
  return false;
}

/**
 * The path the sweep is pointed at, resolved through its links, or null where
 * the worktree is already gone.
 *
 * A path of one segment or none is refused rather than swept: `lsof` and
 * `/proc` answer for the whole host, and every process on it runs from
 * somewhere under `/`.
 */
function sweepRoot(worktree: string): string | null {
  let root: string;
  try {
    root = realpathSync(resolve(worktree));
  } catch {
    return null;
  }
  if (root.split(sep).filter((segment) => segment.length > 0).length < 2) {
    throw new Error(
      `refusing to sweep ${root}: an attempt's worktree is deeper than this, and a sweep of a ` +
        "path this shallow would reach processes that have nothing to do with the attempt",
    );
  }
  return root;
}

/** The runner's own pid and every pid above it, which are never signalled. */
function selfAndAncestors(table: readonly RunningProcess[]): Set<number> {
  const parent = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const chain = new Set<number>();
  let at: number | undefined = process.pid;
  while (at !== undefined && at > 0 && !chain.has(at)) {
    chain.add(at);
    at = parent.get(at);
  }
  return chain;
}

const signal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH: already gone, which is the outcome the signal wanted.
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * End every process running from inside `worktree`, and say what was ended.
 *
 * `SIGTERM` first and `SIGKILL` to whatever is left two seconds later, which is
 * the escalation the executor's own termination uses. Only pids whose current
 * directory, open executable or command line is inside the worktree are
 * signalled, and never the runner or anything it descends from.
 *
 * A pid is signalled a moment after it was listed, so in principle the kernel
 * could have reused it in between; the alternative — holding every process on
 * the host still while the list is read — does not exist.
 */
export async function sweepWorktree(args: {
  worktree: string;
  onProgress?: (line: string) => void;
  escalateAfterMs?: number;
}): Promise<SweptProcess[]> {
  const root = sweepRoot(args.worktree);
  if (root === null) return [];

  const table = await processTable();
  const ours = selfAndAncestors(table);
  const found = table.filter(
    (entry) =>
      entry.pid > 1 &&
      !ours.has(entry.pid) &&
      (entry.paths.some((path) => under(path, root)) || mentions(entry.command, root)),
  );
  if (found.length === 0) return [];

  for (const entry of found) signal(entry.pid, "SIGTERM");
  const escalateAfterMs = args.escalateAfterMs ?? SWEEP_ESCALATION_MS;
  for (let waited = 0; waited < escalateAfterMs; waited += SETTLE_INTERVAL_MS) {
    if (!found.some((entry) => alive(entry.pid))) break;
    await sleep(Math.min(SETTLE_INTERVAL_MS, escalateAfterMs - waited));
  }
  for (const entry of found) {
    if (alive(entry.pid)) signal(entry.pid, "SIGKILL");
  }

  const ended = found.map((entry) => ({ pid: entry.pid, command: entry.command }));
  args.onProgress?.(
    `ended ${ended.length} process(es) still running under the worktree: ` +
      ended
        .slice(0, NAMED_IN_PROGRESS)
        .map((entry) => `${entry.pid} ${entry.command.slice(0, COMMAND_CHARS)}`)
        .join("; ") +
      (ended.length > NAMED_IN_PROGRESS ? `; and ${ended.length - NAMED_IN_PROGRESS} more` : ""),
  );
  return ended;
}
