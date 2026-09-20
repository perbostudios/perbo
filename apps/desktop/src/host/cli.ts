import { childEnvironment } from "./process.js";
import type {
  LineProcess,
  LineProcessOptions,
  ProcessOptions,
  ProcessResult,
  runProcess,
  startLineProcess,
} from "./process.js";
import type { RegisteredRepository } from "./profile/store.js";

/**
 * The bundled CLI, run against one registered repository.
 *
 * Every command is the same binary, the same environment and the same
 * `--repo`: the repository is named by the path this host registered rather
 * than by the process's working directory alone, and a renderer never names a
 * binary or a flag.
 */
export interface Cli {
  run(
    args: string[],
    repo: RegisteredRepository,
    options?: Partial<ProcessOptions>,
  ): Promise<ProcessResult>;
  /**
   * The same CLI as a child that stays: stdin written a line at a time and
   * stdout read the same way. The interview is the one command shaped like
   * that, because the conversation is the process (D-102).
   */
  spawn(
    args: string[],
    repo: RegisteredRepository,
    options: Omit<LineProcessOptions, "cwd" | "env">,
  ): LineProcess;
}

export function createCli(options: {
  nodeBinary: string;
  cliPath: string;
  /** Electron's own binary runs as Node only when it is told to. */
  electronNode?: boolean | undefined;
  execute: typeof runProcess;
  spawn: typeof startLineProcess;
}): Cli {
  const environment = (): NodeJS.ProcessEnv => {
    const env = childEnvironment();
    if (options.electronNode) env.ELECTRON_RUN_AS_NODE = "1";
    return env;
  };
  const argv = (args: string[], repo: RegisteredRepository): string[] => [
    options.cliPath,
    ...args,
    "--repo",
    repo.path,
  ];
  return {
    run: (args, repo, process = {}) =>
      options.execute(options.nodeBinary, argv(args, repo), {
        ...process,
        cwd: repo.path,
        env: environment(),
      }),
    spawn: (args, repo, line) =>
      options.spawn(options.nodeBinary, argv(args, repo), {
        ...line,
        cwd: repo.path,
        env: environment(),
      }),
  };
}
