// Connection rules for live feedback while dragging a wire. They mirror deploy.py's
// checks, worded the same way, but deploy.py stays authoritative: a refused drop asks the
// backend (deploy.py) for its message, and the top bar shows deploy.py's validation of
// the whole manifest.
//
// A wire always joins a transformer and a dataset: dataset -> transformer is one of its
// Inputs, transformer -> dataset its Output.

import type { Catalog, GraphEdge, GraphNode } from "../types";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Check = { ok: true } | { ok: false; reason: string; kind: RefusalKind };
export type RefusalKind = "kind" | "duplicate" | "type" | "cycle" | "self";

/** The schema a dataset carries, from the catalog. */
export function datasetSchema(catalog: Catalog | null, dataset: string | undefined): string | undefined {
  return (dataset && catalog?.datasets[dataset]?.Schema) || undefined;
}

/** The schema a node writes: a transformer's OUT, a dataset's own schema. */
export function emits(node: GraphNode | undefined, catalog: Catalog | null): string | undefined {
  if (!node) return undefined;
  return node.kind === "transformer" ? node.transformer?.OUT || undefined : datasetSchema(catalog, node.dataset);
}

/** The schema a node reads: a transformer's IN, a dataset's own schema. */
export function expects(node: GraphNode | undefined, catalog: Catalog | null): string | undefined {
  if (!node) return undefined;
  return node.kind === "transformer" ? node.transformer?.IN || undefined : datasetSchema(catalog, node.dataset);
}

/** The datasets a transformer writes, in name order (the manifest's Output); each output record goes to all. */
export function outputsOf(graph: GraphLike, transformer: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.source === transformer)
    .map((e) => byId.get(e.target))
    .filter((n) => n?.kind === "dataset")
    .map((n) => n!.dataset!);
  return [...new Set(ds)].sort();
}

/** The datasets a transformer reads, in name order (the manifest's Inputs). */
export function inputsOf(graph: GraphLike, transformer: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.target === transformer)
    .map((e) => byId.get(e.source))
    .filter((n) => n?.kind === "dataset")
    .map((n) => n!.dataset!);
  return [...new Set(ds)].sort();
}

function reaches(edges: GraphEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of edges) if (e.source === n) stack.push(e.target);
  }
  return false;
}

export function checkConnection(graph: GraphLike, catalog: Catalog | null, source: string, target: string): Check {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const s = byId.get(source);
  const t = byId.get(target);
  if (!s || !t) return { ok: false, kind: "kind", reason: "unknown node" };
  if (s.kind === "transformer" && t.kind === "transformer") {
    return { ok: false, kind: "kind", reason: `${source} -> ${target}: transformers connect through a dataset; drop a dataset between them` };
  }
  if (s.kind === "dataset" && t.kind === "dataset") {
    return { ok: false, kind: "kind", reason: "datasets connect through a transformer" };
  }
  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, kind: "duplicate", reason: "already connected" };
  }
  if (s.kind === "transformer") {
    const ds = t.dataset!;
    if (inputsOf(graph, source).includes(ds)) {
      return { ok: false, kind: "self", reason: `Transformers.${source}.Output: ${source} reads and writes ${ds}` };
    }
    const out = emits(s, catalog);
    const carried = datasetSchema(catalog, ds);
    if (out && carried && out !== carried) {
      return { ok: false, kind: "type", reason: `Transformers.${source}.Output: ${source} emits ${out} but ${ds} carries ${carried}` };
    }
  } else {
    const ds = s.dataset!;
    if (outputsOf(graph, target).includes(ds)) {
      return { ok: false, kind: "self", reason: `Transformers.${target}.Output: ${target} reads and writes ${ds}` };
    }
    const carried = datasetSchema(catalog, ds);
    const want = expects(t, catalog);
    if (carried && want && carried !== want) {
      return { ok: false, kind: "type", reason: `Transformers.${target}.Inputs: ${ds} carries ${carried} but ${target} expects ${want}` };
    }
  }
  if (reaches(graph.edges, target, source)) {
    return { ok: false, kind: "cycle", reason: `cycle detected — ${target} already feeds ${source}` };
  }
  return { ok: true };
}

/** The short form shown in the drag tooltip: "raw.xml carries XmlPackets but Base64Decoder expects EncodedPackets". */
export function shortReason(reason: string): string {
  return reason.replace(/^Transformers\.[^:]+: /, "");
}
