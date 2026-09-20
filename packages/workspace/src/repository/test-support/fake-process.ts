import type { RunResult } from "../../exec.js";
import type { GitProcess, ProcessOptions } from "../index.js";

/** One call the fake was asked to make, exactly as the module built it. */
export interface RecordedCall {
  argv: string[];
  options: ProcessOptions;
}

/** What git says to a call whose argv begins with `when`. */
export interface ScriptedAnswer {
  when: readonly string[];
  /** Anything left out is a command that succeeded and said nothing. */
  then: Partial<RunResult>;
}

export interface FakeGitProcess extends GitProcess {
  readonly calls: RecordedCall[];
}

const silentSuccess = (argv: readonly string[]): RunResult => ({
  argv: [...argv],
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  duration_ms: 0,
  timed_out: false,
  truncated: false,
});

/**
 * A git that answers from a script rather than from a repository.
 *
 * For the questions whose answer is not git's: that a refused operand is
 * refused before anything is spawned, that a caller passes the timeout it
 * meant to, that the argv a question builds is the one intended. Where the
 * behaviour under test *is* git's, use a real repository instead — a fake that
 * knows what git would have said is a test of this file.
 *
 * A call the script does not match succeeds silently, so a test that only
 * cares which calls were made does not have to describe them.
 */
export function fakeGitProcess(script: readonly ScriptedAnswer[] = []): FakeGitProcess {
  const calls: RecordedCall[] = [];

  const answer = (argv: readonly string[], options: ProcessOptions): RunResult => {
    calls.push({ argv: [...argv], options });
    const scripted = script.find((entry) => entry.when.every((word, index) => argv[index] === word));
    return { ...silentSuccess(argv), ...scripted?.then };
  };

  return {
    calls,
    run: (argv, options) => Promise.resolve(answer(argv, options)),
    runSync: (argv, options) => answer(argv, options),
  };
}
