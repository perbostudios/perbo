/**
 * Why a piece of inline code was refused, where the shape is a common one.
 *
 * These no longer decide admission — the allow-list below does that, and it
 * refuses by default — but a refusal an agent can act on says which call earned
 * it. A rule that matches supplies the sentence for a refusal already made, so
 * `open('x','w')` reads as "opens a file for writing" rather than as an
 * unrecognised construct. Order matters only for which sentence is printed.
 *
 * Exported so a test can strip one entry and watch the sentence change.
 */
export const INLINE_WRITE_CALLS: Array<{ id: string; pattern: RegExp; detail: string }> = [
  {
    id: "write-file",
    pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync|write_text|write_bytes|writeTextFile|writeFileAtomic)\b/,
    detail: "writes a file",
  },
  { id: "stream-write", pattern: /\.\s*write\s*\(/, detail: "writes to a stream it opened" },
  {
    id: "open-for-writing",
    pattern: /\bopen\s*\([^)]*['"][rbtU]*[wax+][rbtU+]*['"]/,
    detail: "opens a file for writing",
  },
  {
    id: "filesystem-call",
    pattern: /\b(?:mkdir|mkdirSync|makedirs|mkdtemp|mkstemp|rmdir|rmtree|copytree|copyfile|copyfileobj|copyFile|copyFileSync|unlink|unlinkSync|rename|renameSync|symlink|symlinkSync|truncate|ftruncate|chmod|chmodSync|chown|chownSync|utime|touch|rmSync|removedirs)\s*\(/,
    detail: "changes the filesystem",
  },
  {
    id: "spawn",
    pattern: /\b(?:system|popen|spawn|spawnSync|execSync|execFile|execFileSync|execvp|Popen|check_call|check_output|posix_spawn)\s*\(/,
    detail: "spawns a process of its own",
  },
  {
    id: "load-fs-module",
    pattern: /\b(?:require|import)\s*\(\s*['"](?:node:)?(?:fs|fs\/promises|child_process|os)['"]/,
    detail: "loads the filesystem or process library",
  },
  {
    id: "import-fs-module",
    pattern: /(?:^|[\n;])\s*(?:import\s+(?:shutil|subprocess|tempfile)\b|from\s+(?:shutil|subprocess|tempfile)\b)/,
    detail: "imports the filesystem or process library",
  },
  // `awk` writes by redirecting inside its own program text.
  { id: "awk-redirect", pattern: /\bprintf?\b[^\n;]*>>?\s*["'(]/, detail: "redirects its output to a file" },
];

/**
 * The file-writing calls this guard reads by their destination (SCP-234).
 *
 * A program that writes is not by itself a program that escapes: `open(p,'w')`
 * on a path inside the worktree leaves the same bytes a redirect into the
 * worktree leaves, and the rule is about where a write lands. So these calls
 * are judged the way a redirect target is — the destination goes through the
 * resolver — and only where the call spells that destination as a literal in
 * the code. A destination the program computes is refused, because there is
 * nothing to resolve; that is the whole scope of this table, and it is not the
 * beginning of a static analyser.
 *
 * `argument` names the operand that holds the path. Null is the shape whose
 * path is on the value the method is called on instead:
 * `Path('notes.md').write_text('x')`.
 *
 * `open` is here for its write modes only. A read mode is decided where it
 * always was, by the read-only table's `file-read` entry.
 *
 * Exported so a test can strip one entry and watch a line's decision flip.
 */
export interface PlainWriteCall {
  /** The entry's name, which the pin test reads. */
  id: string;
  /** The call's last dotted segment, which is how it is recognised. */
  name: string;
  /** The operand that names the path, or null where the receiver does. */
  argument: number | null;
  /** Why this call's destination is readable, in one line. */
  reason: string;
}

export const PLAIN_WRITE_CALLS: PlainWriteCall[] = [
  {
    id: "open-write",
    name: "open",
    argument: 0,
    reason: "`open` in a write mode names the file it opens in the call itself",
  },
  {
    id: "write-file-sync",
    name: "writeFileSync",
    argument: 0,
    reason: "Node's `writeFileSync` names the file it writes first",
  },
  {
    id: "path-write-text",
    name: "write_text",
    argument: null,
    reason: "`Path(<literal>).write_text` names its file on the path object it is called on",
  },
];

/**
 * A statement form the scan admits whole, once the expression inside it is read.
 *
 * Everything else is an expression statement, which is the ordinary case: the
 * scan reads the calls and the names in it and asks whether the table knows
 * every one.
 */
export type InlineStatementForm = "import" | "binding" | "bare-print" | "control";

/**
 * A shape of inline code this guard can show writes nothing, and why.
 *
 * The reading is the other way round from a deny-list: code is refused unless
 * every statement in it matches one of these, because the set of ways a program
 * can write is not enumerable and the set of ways it can be *shown* not to is.
 * A construct no entry names is refused, and the refusal says which construct,
 * so the agent can rewrite the line rather than guess.
 *
 * This is a statement-level scan over the unwrapped source and nothing more. It
 * does not parse Python or JavaScript, it cannot follow a value through a
 * function, and it is not trying to: the question it answers is whether the
 * text stays inside a vocabulary that has no way to reach the filesystem.
 *
 * How a call is judged, which is where the vocabulary earns its keep:
 *
 * - a **dotted** call is allowed when its full name is in `calls`, so
 *   `json.dumps` is on the list and `json.dump` is not, and `os.environ.get`
 *   is on it while `os.remove` never was;
 * - a call on a receiver this scan cannot name — a literal, a subscript, the
 *   result of another call — is judged by its method name against `methods`,
 *   which is why that list carries no name that writes;
 * - a call on a name **bound by an assignment in this same code** falls back to
 *   `methods` too, because the binding's own statement was read; a name bound
 *   by an `import` does not, so a module's attributes always need the full
 *   name. That is the line that keeps `import os` from meaning `os.remove`.
 *
 * Exported so a test can strip one entry and watch a line's decision flip.
 */
export interface InlineReadOnlyRule {
  /** The entry's name, which the pin test reads. */
  id: string;
  /** Why this shape writes nothing, in one line. */
  reason: string;
  /** Callees allowed by their full dotted name, or as a bare function. */
  calls?: readonly string[];
  /** Method names allowed on a receiver this scan cannot name. */
  methods?: readonly string[];
  /** Bare names allowed as values, matched whole or as a dotted prefix. */
  names?: readonly string[];
  /** Modules an `import` or a `require` may name. */
  modules?: readonly string[];
  /** Statement forms this entry admits. */
  forms?: readonly InlineStatementForm[];
}

export const INLINE_READ_ONLY: InlineReadOnlyRule[] = [
  {
    id: "printing",
    reason: "printing sends bytes to a stream, and a stream is not a file",
    calls: [
      "print", "printf", "puts", "p", "pp", "pprint", "echo", "say", "var_dump", "print_r",
      "console.log", "console.info", "console.debug", "console.warn", "console.error",
      "console.dir", "console.table",
      "process.stdout.write", "process.stderr.write",
      "sys.stdout.write", "sys.stderr.write", "sys.stdout.flush", "sys.stderr.flush",
      "STDOUT.puts", "STDERR.puts", "$stdout.puts", "$stderr.puts",
    ],
    forms: ["bare-print"],
  },
  {
    id: "arithmetic-and-strings",
    reason: "arithmetic and string work happens in memory and names no path",
    calls: [
      "len", "str", "int", "float", "bool", "repr", "abs", "round", "min", "max", "sum",
      "sorted", "list", "dict", "set", "tuple", "range", "enumerate", "zip", "chr", "ord",
      "format", "String", "Number", "Boolean", "Array", "Array.from", "Array.isArray",
      "Object.keys", "Object.values", "Object.entries", "parseInt", "parseFloat",
      "Math.floor", "Math.ceil", "Math.round", "Math.abs", "Math.max", "Math.min",
      "Math.pow", "Math.sqrt", "re.match", "re.search", "re.findall", "re.sub", "re.split",
    ],
    // No name here writes. `replace` is absent on purpose: it is a string method
    // in one language and `Path.replace`, which renames a file, in another.
    methods: [
      "join", "split", "splitlines", "strip", "lstrip", "rstrip", "trim", "trimStart",
      "trimEnd", "upper", "lower", "toUpperCase", "toLowerCase", "title", "capitalize",
      "format", "startswith", "endswith", "startsWith", "endsWith", "includes", "indexOf",
      "lastIndexOf", "index", "count", "find", "slice", "substring", "padStart", "padEnd",
      "repeat", "toString", "toFixed", "charAt", "keys", "values", "items", "entries",
      "get", "sort", "reverse", "concat", "at", "encode", "decode", "toJSON", "valueOf",
    ],
    // `NF` and the rest are what an `awk` program reads; `$1` is handled as a
    // literal-like token, being a field reference rather than a name.
    names: ["NF", "NR", "FS", "OFS", "RS", "ORS", "FILENAME", "ARGV", "ARGC"],
  },
  {
    id: "json",
    reason: "parsing JSON reads text and builds a value; it opens nothing itself",
    // `json.dump` and `JSON` writers are absent: `dump` takes a file object.
    calls: ["JSON.parse", "JSON.stringify", "json.loads", "json.dumps", "json.load"],
  },
  {
    id: "file-read",
    reason:
      "reading a file names a path, and the pass above already resolved every path in " +
      "this code against the root; a mode that is not a read mode is refused here",
    calls: [
      "open", "readFileSync", "fs.readFileSync", "Path", "pathlib.Path",
      "sys.stdin.read", "sys.stdin.readlines", "sys.stdin.readline",
      "process.stdin.read", "$stdin.read", "STDIN.read",
    ],
    methods: [
      "read", "readline", "readlines", "read_text", "read_bytes", "exists", "is_file",
      "is_dir", "resolve", "glob", "iterdir", "stat",
    ],
  },
  {
    id: "environment",
    reason: "a version or an environment lookup answers a question and changes nothing",
    calls: [
      "os.environ.get", "os.getenv", "os.getcwd", "os.path.join", "os.path.exists",
      "os.path.basename", "os.path.dirname", "os.path.abspath", "os.path.isfile",
      // `platform.system` is absent though it only reports the OS name: a table
      // this one is read for safety should not carry a segment called `system`,
      // and `platform.python_version` answers the question that gets asked.
      "os.path.isdir", "platform.machine", "platform.python_version", "platform.release",
      "process.cwd", "process.memoryUsage", "process.uptime", "path.join", "path.resolve",
      "path.basename", "path.dirname", "util.inspect",
    ],
    names: [
      "process.version", "process.versions", "process.platform", "process.arch",
      "process.pid", "process.env", "process.argv", "process.execPath",
      "sys.version", "sys.version_info", "sys.platform", "sys.argv", "sys.executable",
      "sys.maxsize", "sys.path", "os.environ", "os.sep", "os.linesep", "os.name",
      "os.curdir", "RUBY_VERSION", "RUBY_PLATFORM", "PHP_VERSION", "ENV",
    ],
  },
  {
    id: "imports",
    reason:
      "importing a module on this list neither names a file nor writes one; what the " +
      "module then exposes is still judged call by call, which is why `os` can be here",
    calls: ["require"],
    modules: [
      "json", "sys", "re", "math", "pathlib", "platform", "os", "string", "textwrap",
      "decimal", "path", "node:path", "util", "node:util",
    ],
    forms: ["import"],
  },
  {
    id: "binding",
    reason: "binding a name to a read-only expression carries its answer, not a new power",
    forms: ["binding"],
  },
  {
    id: "control-flow",
    reason:
      "a `for`, an `if` or a `while` chooses which statements run and calls nothing of " +
      "its own; what it decides on is an expression read like any other, and each " +
      "statement it guards is read on its own",
    forms: ["control"],
  },
];
