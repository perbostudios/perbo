import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Every process this package starts goes through here, and it takes **argv**.
 *
 * There is no shell. That is not a style preference: a shell string is the one
 * place where a value that should have been an argument becomes a command, and
 * ADR-0023 §4 says no model output becomes an action parameter. An argv array
 * makes the weaker property — a value is one argument, whatever it contains —
 * structural rather than remembered.
 */

export interface RunOptions {
  cwd: string;
  /** The complete environment. Nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Bytes of stdout/stderr retained. Beyond it the tail is kept. */
  maxOutputBytes?: number;
}

export interface RunResult {
  argv: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  /**
   * The command wrote more than `maxOutputBytes` and part of what it wrote is
   * gone. Whoever reads `stdout` as an answer has a fragment, and the flag is
   * the only thing that says so: a cut list, diff or listing is otherwise
   * shaped exactly like a complete one.
   */
  truncated: boolean;
}

/** Everything `run` takes but the line callback, which needs a live stream. */
export type SyncRunOptions = Omit<RunOptions, "onLine">;

const DEFAULT_MAX_OUTPUT = 512 * 1024;

/** Lines of the command's stderr the message carries. */
const REPORTED_STDERR_LINES = 10;
/** Characters of them, past which the tail is what is kept. */
const REPORTED_STDERR_BYTES = 1500;

/**
 * What the command wrote to standard error, indented under the message.
 *
 * The exit code says a command failed; only this says why. Without it a signing
 * key nothing can unlock, a hook that refused the commit and a repository that
 * moved are all "exited 128", and whoever prints the message has nothing to
 * pass on.
 */
function said(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-REPORTED_STDERR_LINES);
  if (lines.length === 0) return "";
  const body = lines.map((line) => `  ${line}`).join("\n");
  return `; it said:\n${
    body.length <= REPORTED_STDERR_BYTES ? body : `  …${body.slice(body.length - REPORTED_STDERR_BYTES)}`
  }`;
}

export class CommandFailedError extends Error {
  readonly result: RunResult;

  constructor(result: RunResult) {
    super(
      // Whitespace inside an argument is collapsed so the command stays one
      // line: a seal's `-m` argument is a whole commit message.
      `${result.argv.map((argument) => argument.replace(/\s+/g, " ")).join(" ")} exited ${
        result.code ?? result.signal ?? "unknown"
      }` +
        (result.timed_out ? " (timed out)" : "") +
        (result.truncated ? " (output truncated)" : "") +
        said(result.stderr),
    );
    this.name = "CommandFailedError";
    this.result = result;
  }
}

/** What is kept of a stream, and whether keeping it lost anything. */
interface Captured {
  text: string;
  truncated: boolean;
}

function tail(chunks: string[], max: number): Captured {
  const joined = chunks.join("");
  if (joined.length <= max) return { text: joined, truncated: false };
  return { text: `…${joined.slice(joined.length - max)}`, truncated: true };
}

export function run(argv: string[], options: RunOptions): Promise<RunResult> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("run() requires a command");
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    // `detached` puts the child at the head of its own process group, which is
    // what makes the timeout below able to reach a grandchild. Without it a
    // build tool that leaves a persistent worker running survives the kill and
    // keeps the pipes open.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true,
    });

    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGKILL");
    }, options.timeoutMs);

    const wire = (stream: "stdout" | "stderr", sink: string[]) => {
      let partial = "";
      const source = stream === "stdout" ? child.stdout : child.stderr;
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        sink.push(chunk);
        if (!options.onLine) return;
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) options.onLine(stream, line);
      });
      source.on("end", () => {
        if (options.onLine && partial.length > 0) options.onLine(stream, partial);
      });
    };
    wire("stdout", out);
    wire("stderr", err);

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      const stdout = tail(out, max);
      const stderr = tail(err, max);
      resolve({
        argv,
        code,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      reject(error);
    });

    // `close` is the one to prefer: it means the pipes are drained as well as
    // the process gone. But it fires only once **every** holder of those pipes
    // has let go, and a grandchild that inherited them need not ever do that —
    // so `exit` starts a short grace period, and the result is returned with
    // whatever has arrived if the pipes never close. Waiting for `close`
    // unconditionally is an unbounded hang that no timeout can clear, which is
    // what it did: 53 minutes on a corpus measurement whose command had long
    // since exited.
    let drain: NodeJS.Timeout;
    child.on("close", (code, signal) => settle(code, signal));
    child.on("exit", (code, signal) => {
      // The timeout is cleared here, not only in `settle`. A command that
      // finished just under the limit was otherwise reported `timed_out: true`
      // beside `code: 0`, and `killGroup` fired at a pid Node had already
      // reaped.
      clearTimeout(timer);
      drain = setTimeout(() => {
        // The grace period expired with the pipes still held — by a grandchild
        // the command left behind, which is the case this path exists for.
        // Settling alone left it running with the pipes open, so the process
        // never exited and the captured output grew without bound. Signal the
        // group and hang up before returning.
        killGroup(child, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signal);
      }, PIPE_DRAIN_GRACE_MS);
      drain.unref?.();
    });
  });
}

/**
 * Signal the child's whole process group.
 *
 * A negative pid means "the group", which reaches the grandchildren a build
 * tool leaves behind. Falls back to the child alone if the group has already
 * gone, which throws ESRCH rather than returning a status.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** The same, but a non-zero exit is an error rather than a value. */
/** How long after a child exits to wait for its pipes, before returning anyway. */
const PIPE_DRAIN_GRACE_MS = 250;

export async function runOrThrow(argv: string[], options: RunOptions): Promise<RunResult> {
  const result = await run(argv, options);
  if (result.code !== 0) throw new CommandFailedError(result);
  return result;
}

/**
 * The same, without the event loop.
 *
 * A synchronous call is for a short local read — `rev-parse`, `ls-files`,
 * `config --get` — asked from somewhere that cannot await. `spawnSync` cannot
 * detach the child, so there is no process group to signal and nothing here
 * can reach a grandchild the command leaves behind; a command that might leave
 * one belongs on `run`.
 *
 * A process that never started throws the Node error unchanged, because
 * "this machine has no git" is a different answer from "git said no" and only
 * the caller knows which of the two it can act on.
 */
export function runSync(argv: string[], options: SyncRunOptions): RunResult {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("runSync() requires a command");
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = Date.now();

  const child = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs,
    // Node reads a chunk before it compares against this, so the buffer is a
    // ceiling on what is delivered rather than on what is captured: `tail`
    // below is what actually bounds the result, and this is what makes the
    // overflow reportable.
    maxBuffer: max,
    encoding: "utf8",
  });

  const failure = child.error as NodeJS.ErrnoException | undefined;
  const timedOut = failure?.code === "ETIMEDOUT";
  const overflowed = failure?.code === "ENOBUFS";
  if (failure !== undefined && !timedOut && !overflowed) throw failure;

  const stdout = tail([child.stdout ?? ""], max);
  const stderr = tail([child.stderr ?? ""], max);
  return {
    argv,
    code: child.status,
    signal: child.signal,
    stdout: stdout.text,
    stderr: stderr.text,
    duration_ms: Date.now() - startedAt,
    timed_out: timedOut,
    truncated: overflowed || stdout.truncated || stderr.truncated,
  };
}
