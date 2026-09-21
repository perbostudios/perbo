import { UsageError } from "../usage-error.js";

/**
 * The one set of rules `perbo` reads a command line by.
 *
 * A command declares which flags exist, what each takes and how many
 * positionals it accepts; everything about *how* argv is walked is here, so
 * every command answers the same way to the same shape of line. Per-value
 * checks — enums, integers, key shapes, URLs, dates — are not grammar: they
 * belong to the command's input schema, where an in-process caller gets them
 * too.
 *
 * The rule that makes the rest safe is that `--name=value` is split **only in
 * flag position**. A value is taken verbatim and is never read again as a
 * flag, so text a person typed — an outcome, a note, a path — stays text
 * whatever it is shaped like.
 */

/** A flag that is either given or not, and never carries a value. */
export interface SwitchSpec {
  readonly kind: "switch";
  /** Not named in `USAGE`: a harness's flag rather than one the product offers. */
  readonly hidden: boolean;
}

/** A flag that carries a value. */
export interface ValueSpec<Repeat extends "last" | "append" = "last" | "append"> {
  readonly kind: "value";
  /**
   * What a second occurrence means. `last` replaces, which is what every
   * command has always done and what the desktop's trailing `--repo` relies
   * on; `append` accumulates in the order the values were given.
   */
  readonly repeat: Repeat;
  /**
   * Refuse a value that is missing, or that is a separate token starting with
   * `--`, saying this. For the few flags where the next token is far more
   * likely to be another flag whose own value was forgotten than a value of
   * this one, and where taking it would be reported later as something else
   * entirely (SCP-189). One message covers both, because both are the same
   * thing to the person reading it: what this flag needed is not there.
   */
  readonly refuseFlagShaped: string | null;
  /**
   * The flag this one is another spelling of. Its value is recorded under that
   * name, so two spellings of one flag are one flag: the last of them given
   * wins, whichever was written.
   */
  readonly aliasOf: `--${string}` | null;
  readonly hidden: boolean;
}

export type FlagSpec = SwitchSpec | ValueSpec;

export type FlagTable = Readonly<Record<`--${string}`, FlagSpec>>;

/** A flag that is either given or not. */
export const switchFlag = (options: { hidden?: boolean } = {}): SwitchSpec => ({
  kind: "switch",
  hidden: options.hidden ?? false,
});

/** A flag taking one value; a repeat replaces what came before it. */
export const valueFlag = (
  options: { refuseFlagShaped?: string; hidden?: boolean } = {},
): ValueSpec<"last"> => ({
  kind: "value",
  repeat: "last",
  refuseFlagShaped: options.refuseFlagShaped ?? null,
  aliasOf: null,
  hidden: options.hidden ?? false,
});

/**
 * Another spelling of a value flag, recorded under the name it spells: the
 * command reads one field, and `--title x --outcome y` means what the last of
 * them says.
 */
export const aliasFlag = (canonical: `--${string}`): ValueSpec<"last"> => ({
  kind: "value",
  repeat: "last",
  refuseFlagShaped: null,
  aliasOf: canonical,
  hidden: true,
});

/** A flag taking one value each time it is given; the values accumulate in order. */
export const listFlag = (options: { hidden?: boolean } = {}): ValueSpec<"append"> => ({
  kind: "value",
  repeat: "append",
  refuseFlagShaped: null,
  aliasOf: null,
  hidden: options.hidden ?? false,
});

/** What a parsed line holds for each flag the command declares. */
export type FlagValues<F extends FlagTable> = {
  readonly [Name in keyof F]?: F[Name] extends SwitchSpec
    ? true
    : F[Name] extends ValueSpec<"append">
      ? readonly string[]
      : string;
};

/** How many positionals a command takes, and what it says when it gets another number. */
export interface PositionalSpec {
  readonly min: number;
  readonly max: number;
  /** Written for the person who typed the wrong number, naming the right one. */
  readonly refusal: string;
}

export interface Grammar<F extends FlagTable = FlagTable> {
  /** The command as its refusals name it: `admit`, `sync --all-merged`, `baseline start`. */
  readonly command: string;
  readonly flags: F;
  readonly positionals: PositionalSpec;
  /**
   * What `--` introduces: more positionals, or arguments this command hands
   * to another program untouched.
   */
  readonly afterDoubleDash: "positionals" | "passthrough";
  /** Added to an unknown flag's refusal, where the command has somewhere to point. */
  readonly unknownFlagHint?: string;
}

export interface ParsedLine<F extends FlagTable> {
  readonly flags: FlagValues<F>;
  /**
   * Every flag in the order it was written, repeats included and spelled as
   * the person spelled it — for a command whose refusal names which two of a
   * group were given, which {@link ParsedLine.flags} cannot say.
   */
  readonly given: readonly string[];
  readonly positionals: readonly string[];
  /** Everything after `--` for a command that passes it on; empty otherwise. */
  readonly passthrough: readonly string[];
  /** `--help` or `-h` was asked for in flag position, and nothing else was read. */
  readonly help: boolean;
}

/**
 * Whether the line asks for help, deciding it before anything about the line
 * is validated — so `perbo list --typo --help` prints the help rather than
 * refusing the typo, which is what asking for help is for.
 *
 * Only a token in flag position counts. One consumed as a value is that value
 * (`perbo admit --outcome --help` admits), and one after `--` belongs to
 * whatever `--` introduced (`perbo agent -- --help` asks the provider).
 */
export function asksForHelp(grammar: Grammar, argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
    if (!token.startsWith("--") || token.includes("=")) continue;
    // An unknown name is refused by the parse, not here; stepping over it as a
    // flag that takes nothing is what keeps this walk in step with that one
    // for every line the parse goes on to accept.
    const spec = grammar.flags[token as `--${string}`];
    if (spec?.kind === "value") index += 1;
  }
  return false;
}

const unknownFlag = (grammar: Grammar, name: string): UsageError =>
  new UsageError(
    `unknown flag '${name}' for ${grammar.command}` +
      (grammar.unknownFlagHint === undefined ? "" : ` (${grammar.unknownFlagHint})`),
  );

/**
 * `argv` as the command declared it: its flags, its positionals, and what it
 * passes on.
 *
 * Tokens are read left to right. A token is in flag position unless a flag
 * before it took it as a value or it came after `--`.
 */
export function parseArgv<F extends FlagTable>(
  grammar: Grammar<F>,
  argv: readonly string[],
): ParsedLine<F> {
  if (asksForHelp(grammar, argv)) {
    return { flags: {} as FlagValues<F>, given: [], positionals: [], passthrough: [], help: true };
  }

  const flags: Record<string, true | string | string[]> = {};
  const given: string[] = [];
  const positionals: string[] = [];
  const passthrough: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      const rest = argv.slice(index + 1);
      if (grammar.afterDoubleDash === "passthrough") passthrough.push(...rest);
      else positionals.push(...rest);
      break;
    }

    // `-`, `-x` and anything else without the two dashes is a positional:
    // there are no short flags, so a lone dash is standard input and a value
    // beginning with one is that value.
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    // Split at the first `=`, and only here, in flag position. This is the
    // whole of the inline form: a value is never split and never re-read.
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? null : token.slice(equals + 1);

    const spec = grammar.flags[name as `--${string}`];
    if (spec === undefined) throw unknownFlag(grammar, name);

    if (spec.kind === "switch") {
      // `--json=`, `--json=x` and `--json=false` are all a person asking this
      // flag to carry something it has no way to mean.
      if (inline !== null) throw new UsageError(`${name} does not take a value`);
      flags[name] = true;
      given.push(name);
      continue;
    }

    let value: string;
    if (inline !== null) {
      value = inline;
    } else {
      const next = argv[index + 1];
      if (spec.refuseFlagShaped !== null && (next === undefined || next.startsWith("--"))) {
        throw new UsageError(spec.refuseFlagShaped);
      }
      if (next === undefined) throw new UsageError(`${name} requires a value`);
      value = next;
      index += 1;
    }

    given.push(name);
    const field = spec.aliasOf ?? name;
    if (spec.repeat === "append") {
      const collected = flags[field];
      if (Array.isArray(collected)) collected.push(value);
      else flags[field] = [value];
    } else {
      flags[field] = value;
    }
  }

  if (positionals.length < grammar.positionals.min || positionals.length > grammar.positionals.max) {
    throw new UsageError(grammar.positionals.refusal);
  }

  return {
    flags: flags as FlagValues<F>,
    given,
    positionals,
    passthrough,
    help: false,
  };
}
