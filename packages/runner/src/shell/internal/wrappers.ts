export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "busybox"]);
/** Shell syntax that stands before a command and takes no options of its own. */
export const KEYWORDS = new Set([
  "(", ")", "{", "}", "&", "!", "if", "then", "else", "elif", "fi", "while",
  "until", "do", "done", "case", "esac", "in",
]);

/**
 * A program that runs another program, and the options it takes before naming
 * it. The options matter: without them the first `-flag` after the wrapper
 * reads as the program, and the command it actually runs is never judged.
 *
 * `commands` names an option whose operand is itself a command line. An option
 * in none of the three sets is refused rather than skipped, because skipping it
 * may skip the program name with it.
 */
export interface WrapperSpec {
  flags?: readonly string[];
  values?: readonly string[];
  commands?: readonly string[];
  /** Options whose value is a directory the wrapped command runs in. */
  dirs?: readonly string[];
  /** Options whose value is a file the wrapper itself writes, as `time -o`. */
  destinations?: readonly string[];
  /** Options refused by name, because their operand hides a command. */
  refuse?: readonly string[];
  /**
   * True where the wrapper appends the words it reads from standard input to
   * the command it runs. Those words are operands the line does not spell, so a
   * writer behind such a wrapper is handed destinations the guard cannot see.
   */
  appendsOperands?: boolean;
  /**
   * Options that make an appending wrapper substitute instead: the words it
   * reads replace a placeholder in operands the line already spells, and the
   * option's value is that placeholder. An operand that is not the placeholder
   * stays readable; one that is, is a word the line does not spell.
   */
  substitutes?: readonly string[];
  /**
   * Options whose value is optional and only ever attached, as `xargs -i[str]`
   * and `--replace[=str]` are. The word after one is the command the wrapper
   * runs rather than the option's value.
   */
  attachedValues?: readonly string[];
  /** Substituting options that replace only an operand equal to the placeholder. */
  substitutesWholeWord?: readonly string[];
  /** What a substituting option that named no placeholder stands for. */
  defaultPlaceholder?: string;
  /** True where a bare `-5` is an option, as it is for `nice`. */
  numeric?: boolean;
  /** Operands taken before the program, as `timeout` takes a duration. */
  operands?: number;
}

export const WRAPPERS = new Map<string, WrapperSpec>([
  ["env", {
    flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug", "--help", "--version"],
    values: ["-u", "-a", "--unset"],
    dirs: ["-C", "--chdir"],
    refuse: ["-S", "--split-string"],
  }],
  ["nice", { flags: ["--help", "--version"], values: ["-n", "--adjustment"], numeric: true }],
  ["ionice", { flags: ["-t", "-h", "--help"], values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid"] }],
  ["stdbuf", { flags: ["--help", "--version"], values: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
  ["time", { flags: ["-p", "-a", "-v", "-q", "--portability", "--append", "--verbose", "--quiet", "--help", "--version"], values: ["-f", "--format"], destinations: ["-o", "--output"] }],
  ["command", { flags: ["-p", "-v", "-V"] }],
  ["builtin", {}],
  ["exec", { flags: ["-c", "-l"], values: ["-a"] }],
  ["nohup", { flags: ["--help", "--version"] }],
  ["sudo", {
    flags: ["-b", "-E", "-e", "-H", "-i", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-V", "-v", "-A", "--background", "--edit", "--set-home", "--login", "--remove-timestamp", "--list", "--non-interactive", "--preserve-groups", "--stdin", "--shell", "--version", "--validate", "--askpass", "--reset-timestamp"],
    values: ["-C", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u", "-c", "--close-from", "--group", "--host", "--prompt", "--chroot", "--role", "--command-timeout", "--type", "--other-user", "--user"],
    dirs: ["-D", "--chdir"],
  }],
  ["doas", { flags: ["-n", "-s", "-L"], values: ["-a", "-C", "-u"] }],
  ["timeout", {
    flags: ["-f", "-v", "--foreground", "--preserve-status", "--verbose", "--help", "--version"],
    values: ["-s", "-k", "--signal", "--kill-after"],
    operands: 1,
  }],
  ["xargs", {
    flags: ["-0", "-o", "-p", "-r", "-t", "-x", "--null", "--no-run-if-empty", "--interactive", "--open-tty", "--verbose", "--exit", "--help", "--version"],
    values: ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-s", "--arg-file", "--delimiter", "--eof", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
    appendsOperands: true,
    substitutes: ["-I", "-i", "-J", "--replace"],
    // GNU takes these values only attached (`-i{}`, `-e_`, `-l3`); a separate
    // word after them is the program.
    attachedValues: ["-i", "-e", "-l", "--replace"],
    // BSD's `-J` replaces the placeholder only where it stands alone as an
    // operand, and appends the input where it does not.
    substitutesWholeWord: ["-J"],
    defaultPlaceholder: "{}",
  }],
]);

/**
 * `pnpm`, `npm`, `yarn` and `bun` wrap a command only through `exec`, `dlx` and
 * `x`; `run <script>` names a script this line does not contain, and every
 * other subcommand runs no command of the agent's.
 */
export const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

export const PACKAGE_MANAGER_SPEC: WrapperSpec = {
  flags: [
    "-r", "-s", "-w", "--recursive", "--workspace-root", "--silent", "--stream", "--no-bail",
    "--if-present", "--parallel", "--sequential", "--aggregate-output", "--shell-mode",
    "--no-color", "--color", "--ignore-scripts", "--help", "--version",
  ],
  values: [
    "-F", "--filter", "--filter-prod", "--reporter", "--loglevel", "--use-node-version",
    "--workspace-concurrency", "--resume-from", "--sort", "--workspace",
  ],
  dirs: ["-C", "--dir", "--prefix"],
};

/**
 * The options `pnpm exec`, `npm exec`/`x`, `yarn dlx` and `bun x` take before
 * the program. `-c`, `--shell-mode` and `--call` are pnpm's and npm's shell
 * mode: the operand is a command line, read the way `sh -c`'s is.
 */
export const EXEC_SPEC: WrapperSpec = {
  flags: [
    "-r", "-s", "-y", "--recursive", "--parallel", "--sequential", "--silent", "--stream",
    "--no-bail", "--if-present", "--aggregate-output", "--bun", "--yes", "--no-install",
    "--ignore-scripts", "--report-summary", "--reverse", "--sort", "--no-sort", "--color",
    "--no-color", "--shell-auto-fallback", "--help",
  ],
  values: [
    "-p", "-F", "--package", "--filter", "--filter-prod", "--reporter", "--loglevel",
    "--resume-from", "--use-node-version", "--workspace-concurrency", "--workspace", "-w",
  ],
  dirs: ["-C", "--dir", "--prefix"],
  commands: ["-c", "--shell-mode", "--call"],
};

export const NPX_SPEC: WrapperSpec = {
  flags: [
    "-y", "-q", "--yes", "--no", "--no-install", "--ignore-existing", "--ignore-scripts",
    "--quiet", "--silent", "--prefer-offline", "--prefer-online", "--offline",
    "--always-spawn", "--shell-auto-fallback", "--help", "--version",
  ],
  values: [
    "-p", "-n", "-w", "--package", "--workspace", "--cache", "--userconfig", "--shell",
    "--node-arg", "--loglevel",
  ],
  dirs: ["--prefix"],
  commands: ["-c", "--call"],
};
