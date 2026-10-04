/**
 * The one rule every JSON schema Perbo sends a provider keeps.
 *
 * The transports disagree on what a schema may be, and the strictest of them
 * decides: Codex's structured output refuses a schema whose object leaves a
 * property out of `required` (`invalid_json_schema`), and it and the Anthropic
 * API's strict tool both refuse one that leaves other properties allowed. So
 * every schema is written to that rule, and the same bytes are valid on every
 * transport, with no rewriting at send time:
 *
 * - every key in an object's `properties` is in its `required`;
 * - every object says `additionalProperties: false`;
 * - a value that may be missing is nullable in the schema (`anyOf` with
 *   `{ type: "null" }`, or a `type` list holding `"null"`), and the caller's
 *   parse reads a `null` as absent.
 *
 * The third clause is how a schema keeps the first two while a value is
 * optional. Which values are optional is the caller's knowledge, so this
 * checker holds the first two and each caller's parse tests hold the third.
 * It runs in tests, over every schema Perbo sends, and never at send time.
 */

/** Which clause of the rule a place in a schema breaks. */
export type StrictSchemaClause = "required" | "additionalProperties";

/** One place a schema breaks the rule: a JSON pointer into it, and the clause. */
export interface StrictSchemaViolation {
  path: string;
  clause: StrictSchemaClause;
}

/** The keywords whose value is one subschema. */
const ONE = ["items", "not", "if", "then", "else", "contains", "additionalItems"] as const;
/** The keywords whose value is a list of subschemas. */
const MANY = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
/** The keywords whose value maps names to subschemas. */
const NAMED = ["properties", "$defs", "definitions", "patternProperties"] as const;

function isSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function describesObject(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    isSchema(schema.properties)
  );
}

/**
 * Every place `schema` breaks the rule, in document order; empty where it
 * keeps it. A property left out of `required` is reported at that property,
 * and a missing `additionalProperties: false` at the object.
 */
export function strictSchemaViolations(schema: unknown): StrictSchemaViolation[] {
  const found: StrictSchemaViolation[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((each, index) => walk(each, pointer(path, index)));
      return;
    }
    if (!isSchema(node)) return;
    if (describesObject(node)) {
      if (node.additionalProperties !== false) found.push({ path, clause: "additionalProperties" });
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const properties = isSchema(node.properties) ? Object.keys(node.properties) : [];
      for (const key of properties) {
        if (!required.has(key)) found.push({ path: pointer(pointer(path, "properties"), key), clause: "required" });
      }
    }
    for (const keyword of ONE) if (keyword in node) walk(node[keyword], pointer(path, keyword));
    for (const keyword of MANY) if (keyword in node) walk(node[keyword], pointer(path, keyword));
    for (const keyword of NAMED) {
      const named = node[keyword];
      if (!isSchema(named)) continue;
      for (const [key, value] of Object.entries(named)) walk(value, pointer(pointer(path, keyword), key));
    }
    if (isSchema(node.additionalProperties)) walk(node.additionalProperties, pointer(path, "additionalProperties"));
  };
  walk(schema, "#");
  return found;
}
