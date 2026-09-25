import type { GraphEdge } from "@perbo/contracts/browser";

/**
 * Where a graph's nodes sit: columns, left to right, one column after the
 * latest node that must come before them (D-100).
 *
 * A layered layout of the desktop's own rather than a library's: the renderer
 * runs under a policy that allows no worker and no remote origin, and the
 * order is a suggestion the person curates, so the drawing has to show it and
 * nothing else — no physics, no animation of positions, no layout a second
 * opening would change.
 */

/** The node ids in each column, left to right. */
export function graphColumns(
  nodes: readonly { id: string }[],
  edges: readonly GraphEdge[],
): string[][] {
  const before = new Map<string, string[]>();
  for (const edge of edges) before.set(edge.to, [...(before.get(edge.to) ?? []), edge.from]);
  const held = new Set(nodes.map((node) => node.id));
  const rank = new Map<string, number>();
  // Bounded by the number of nodes: the approach schema refuses a cycle, and a
  // record that somehow held one would still lay out rather than recur forever.
  const rankOf = (id: string, depth: number): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (depth > nodes.length) return 0;
    const parents = (before.get(id) ?? []).filter((parent) => held.has(parent));
    const at =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((parent) => rankOf(parent, depth + 1)));
    rank.set(id, at);
    return at;
  };
  const columns: string[][] = [];
  for (const node of nodes) {
    const at = rankOf(node.id, 0);
    (columns[at] ??= []).push(node.id);
  }
  // Within a column, a node sits near the nodes it follows, so the edges into
  // it cross as little as the ordering allows.
  for (let index = 1; index < columns.length; index += 1) {
    const previous = columns[index - 1] ?? [];
    columns[index] = (columns[index] ?? [])
      .map((id, at) => {
        const places = (before.get(id) ?? [])
          .map((parent) => previous.indexOf(parent))
          .filter((place) => place >= 0);
        return {
          id,
          at:
            places.length === 0
              ? previous.length + at
              : places.reduce((sum, place) => sum + place, 0) / places.length,
        };
      })
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.id);
  }
  return Array.from(columns, (column) => column ?? []);
}

/**
 * What a node's card says under its title: how many criteria it covers and
 * the paths expected to satisfy them, on the Graph pane and on the contract's
 * graph alike (D-NEW-basic-and-epic-flows).
 */
export function nodeSummary(node: { criteria: readonly unknown[]; paths: readonly string[] }): string {
  const count = `${node.criteria.length} ${node.criteria.length === 1 ? "criterion" : "criteria"}`;
  return node.paths.length > 0 ? `${count} · ${node.paths.join(" · ")}` : count;
}
