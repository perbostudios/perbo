import type { z } from "zod";

/** Input a command cannot act on. The entry point turns it into the usage exit code. */
export class UsageError extends Error {}

/**
 * One command's input, checked by its own schema.
 *
 * Every caller reaches the same schema — the terminal through a command's
 * `read`, the endpoint and the interview by building the object — so a rule
 * about a value has one home. A refusal is a {@link UsageError} rather than
 * the schema's own error, because what was wrong is the input, whoever
 * supplied it, and at the terminal that is exit 1 and a sentence rather than
 * exit 3 and a stack.
 */
export function readInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new UsageError(parsed.error.issues.map((issue) => issue.message).join("; "));
}
