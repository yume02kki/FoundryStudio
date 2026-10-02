import type { GraphEdge, GraphNode, Layout } from "../types";

export const COLUMN = 300;
export const ROW = 130;

type Size = { width: number; height: number };
const GAP_X = 110;
const GAP_Y = 40;

/**
 * Layered left-to-right layout: columns by longest path from the roots, each column ordered
 * by its neighbours' positions so wires cross less. `sizes` (measured nodes) spaces things by
 * their real size; without it every node is assumed to be one grid cell.
 */
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[], sizes: Record<string, Size> = {}): Layout["positions"] {
  const ids = new Set(nodes.map((n) => n.id));
  const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest path from the roots (bounded so a cycle can't loop forever).
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of links) {
      const r = rank.get(e.source)! + 1;
      if (r > rank.get(e.target)!) {
        rank.set(e.target, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Pull nodes with no inputs (sources) right next to the column they feed.
  for (const n of nodes) {
    const next = links.filter((e) => e.source === n.id).map((e) => rank.get(e.target)!);
    if (next.length && !links.some((e) => e.target === n.id)) rank.set(n.id, Math.min(...next) - 1);
  }

  const depth = Math.max(0, ...rank.values());
  const columns: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const n of nodes) columns[rank.get(n.id)!].push(n.id);

  // A wire skipping columns gets a placeholder in each column it crosses, so it keeps its own
  // lane instead of running behind the nodes in between.
  const lanes = new Set<string>();
  for (const e of [...links]) {
    const from = rank.get(e.source)!, to = rank.get(e.target)!;
    if (to - from < 2) continue;
    links.splice(links.indexOf(e), 1);
    let prev = e.source;
    for (let r = from + 1; r < to; r++) {
      const lane = `\0${e.source}>${e.target}@${r}`;
      lanes.add(lane);
      columns[r].push(lane);
      links.push({ source: prev, target: lane });
      prev = lane;
    }
    links.push({ source: prev, target: e.target });
  }

  // Barycentre ordering, sweeping down and back up a few times.
  const index = new Map<string, number>();
  const reindex = () => columns.forEach((col) => col.forEach((id, i) => index.set(id, i)));
  reindex();
  const sortBy = (col: string[], neighbours: (id: string) => string[]) => {
    const key = new Map(col.map((id, i) => {
      const ns = neighbours(id);
      return [id, ns.length ? ns.reduce((a, n) => a + index.get(n)!, 0) / ns.length : i];
    }));
    col.sort((a, b) => key.get(a)! - key.get(b)!);
  };
  const preds = (id: string) => links.filter((e) => e.target === id).map((e) => e.source);
  const succs = (id: string) => links.filter((e) => e.source === id).map((e) => e.target);
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r <= depth; r++) { sortBy(columns[r], preds); reindex(); }
    for (let r = depth - 1; r >= 0; r--) { sortBy(columns[r], succs); reindex(); }
  }

  const size = (id: string): Size => (lanes.has(id) ? { width: 0, height: 0 } : sizes[id] ?? { width: COLUMN - GAP_X, height: ROW - GAP_Y });

  // Vertical placement, column by column: each node aims for the middle of what feeds it so
  // chains run straight. Lanes stay level with where their wire starts (React Flow draws it as
  // one curve, so that line must be clear) and the other nodes stack above and below them.
  const centre = new Map<string, number>();
  const stack = (ids: string[], mid: number) => {
    const total = ids.reduce((a, id) => a + size(id).height, 0) + GAP_Y * Math.max(0, ids.length - 1);
    let y = mid - total / 2;
    return ids.map((id) => { const c = y + size(id).height / 2; y += size(id).height + GAP_Y; return c; });
  };
  columns.forEach((col, r) => {
    const want = (id: string) => {
      const ps = r ? preds(id).filter((p) => centre.has(p)) : [];
      return ps.length ? ps.reduce((a, p) => a + centre.get(p)!, 0) / ps.length : 0;
    };
    // Lane levels, kept in column order.
    let floor = -Infinity;
    const fixed = new Map<string, number>();
    for (const id of col) if (lanes.has(id)) { const y = Math.max(want(id), floor); fixed.set(id, y); floor = y + GAP_Y; }
    // Runs of nodes between lanes: centred on what they want, kept clear of the lanes around them.
    let run: string[] = [];
    let above = -Infinity;
    const place = (below: number) => {
      if (!run.length) return;
      const mid = run.reduce((a, id) => a + want(id), 0) / run.length;
      let cs = stack(run, mid);
      const top = cs[0] - size(run[0]).height / 2, bottom = cs[cs.length - 1] + size(run[run.length - 1]).height / 2;
      if (bottom > below - GAP_Y) cs = cs.map((c) => c - (bottom - (below - GAP_Y)));
      else if (top < above + GAP_Y) cs = cs.map((c) => c + (above + GAP_Y - top));
      run.forEach((id, k) => centre.set(id, cs[k]));
      run = [];
    };
    for (const id of col) {
      if (lanes.has(id)) { place(fixed.get(id)!); centre.set(id, fixed.get(id)!); above = fixed.get(id)!; }
      else run.push(id);
    }
    place(Infinity);
  });

  const positions: Layout["positions"] = {};
  let x = 0;
  for (const col of columns) {
    for (const id of col) {
      if (!lanes.has(id)) positions[id] = { x: Math.round(x), y: Math.round(centre.get(id)! - size(id).height / 2) };
    }
    x += Math.max(0, ...col.map((id) => size(id).width)) + GAP_X;
  }
  return positions;
}
