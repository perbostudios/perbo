/**
 * A value git is to read as a thing, not as an instruction.
 *
 * Wherever git expects a ref, a sha or a path, a leading `-` is an option
 * instead, and some of those options write: `git diff --output=<path> …` reads
 * like a query and leaves a file behind. The module builds every argv from the
 * runner's own values, so an operand shaped like an option is a defect in the
 * caller rather than a request to honour — it refuses before spawning, which is
 * the one point where nothing has happened yet.
 *
 * This is the module's side of ADR-0023 §4. It is not the write guard's
 * grammar: that one reads an agent's command line, which is untrusted text and
 * a different job.
 */
export function operand(value: string, role: string): string {
  if (value.length === 0) throw new RangeError(`the ${role} is empty, and git would read the next argument as it`);
  if (value.startsWith("-")) throw new RangeError(`the ${role} ${value} would be read as an option`);
  return value;
}

/** The same, for every operand of one call. */
export function operands(values: readonly string[], role: string): string[] {
  return values.map((value) => operand(value, role));
}
