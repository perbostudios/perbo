import type { TrustTier } from "@perbo/contracts";

/**
 * The same delimiting the reviewer uses (review/src/prompt.ts), under the
 * `perbo:` namespace: every piece of content that is not the system prompt
 * arrives inside a `<perbo:kind trust="...">` block. Two things are done to
 * the content itself, and nothing else — an attribute value cannot carry a
 * double quote, a closing bracket, a delimiter or a line break, and the body
 * cannot carry a tag that would close the block early, because a closing tag inside an issue body is exactly how external
 * text would try to reach the instruction position.
 */
const OPEN = (kind: string, trust: TrustTier, attrs: Record<string, string>) => {
  const rendered = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${attribute(value)}"`)
    .join("");
  return `<perbo:${kind} trust="${trust}"${rendered}>`;
};
const CLOSE = (kind: string) => `</perbo:${kind}>`;

/**
 * `<perbo:` and `</perbo:` inside a body become literal text — in any case,
 * and with whitespace anywhere between the bracket, the slash and the colon,
 * since a reader might take any of those for the delimiter.
 */
export function defang(text: string): string {
  return text.replace(/<(?=\s*\/?\s*perbo\s*:)/gi, "&lt;");
}

/**
 * An attribute value stays on the opening line and inside its quotes: the
 * quote and the closing bracket are escaped, a delimiter it carries is
 * defanged, and a line break becomes a space.
 */
function attribute(value: string): string {
  return defang(value.replace(/"/g, "'").replace(/>/g, "&gt;")).replace(/[\r\n]+/g, " ");
}

export function delimit(args: {
  kind: string;
  trust: TrustTier;
  attrs?: Record<string, string>;
  body: string;
}): string {
  return [OPEN(args.kind, args.trust, args.attrs ?? {}), defang(args.body), CLOSE(args.kind)].join(
    "\n",
  );
}
