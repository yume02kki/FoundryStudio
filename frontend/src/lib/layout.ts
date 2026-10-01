import { SINK, SOURCE, type GraphEdge, type GraphNode, type Layout } from "../types";

export const COLUMN = 300;
export const ROW = 130;

/** Layered left-to-right layout for pipelines without a <Name>.layout.json. */
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[]): Layout["positions"] {
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest path from the roots (bounded so a cycle can't loop forever).
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      const r = (rank.get(e.source) ?? 0) + 1;
      if (rank.has(e.target) && r > (rank.get(e.target) ?? 0)) {
        rank.set(e.target, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const max = Math.max(1, ...[...rank.entries()].filter(([id]) => id !== SINK).map(([, r]) => r + 1));
  rank.set(SOURCE, 0);
  rank.set(SINK, max);

  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    columns.set(r, [...(columns.get(r) ?? []), n.id]);
  }
  const positions: Layout["positions"] = {};
  for (const [r, ids] of columns) {
    ids.forEach((id, i) => {
      positions[id] = { x: r * COLUMN, y: (i - (ids.length - 1) / 2) * ROW };
    });
  }
  return positions;
}
