// Connection rules for live feedback while dragging a wire. They mirror manifest.py's
// checks, worded the same way, but manifest.py stays authoritative: a refused drop asks the
// backend (manifest.py) for its message, and the top bar shows manifest.py's validation of
// the whole manifest.
//
// A wire always joins a transform and a dataset: dataset -> transform is its In,
// transform -> dataset its Out, and a transform has one of each. A transform's schemas
// are those its transformer.yaml declares at its Ref.

import type { GraphEdge, GraphNode, TransformerInfo } from "../types";
import { findInfo, versionFor } from "./versions";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Check = { ok: true } | { ok: false; reason: string; kind: RefusalKind };
export type RefusalKind = "kind" | "duplicate" | "type" | "cycle" | "self" | "single";

export type Transformers = Record<string, TransformerInfo>;

/** The schema a dataset carries (its DataSchema). */
export function datasetSchema(node: GraphNode | undefined): string | undefined {
  return node?.datasetSpec?.DataSchema || undefined;
}

/** A transform's in and out schemas: its transformer.yaml at its Ref (no Ref: the default branch). */
export function transformSchemas(node: GraphNode | undefined, transformers: Transformers): { input?: string; output?: string } {
  const v = versionFor(findInfo(node?.transformer, Object.values(transformers)), node?.transformer?.Ref);
  return { input: v?.input ?? undefined, output: v?.output ?? undefined };
}

/** The schema a node writes: a transform's out, a dataset's own schema. */
export function emits(node: GraphNode | undefined, transformers: Transformers): string | undefined {
  if (!node) return undefined;
  return node.kind === "transformer" ? transformSchemas(node, transformers).output : datasetSchema(node);
}

/** The schema a node reads: a transform's in, a dataset's own schema. */
export function expects(node: GraphNode | undefined, transformers: Transformers): string | undefined {
  if (!node) return undefined;
  return node.kind === "transformer" ? transformSchemas(node, transformers).input : datasetSchema(node);
}

/** The datasets a transform writes, in name order (its Out: one, unless miswired). */
export function outputsOf(graph: GraphLike, transformer: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.source === transformer)
    .map((e) => byId.get(e.target))
    .filter((n) => n?.kind === "dataset")
    .map((n) => n!.dataset!);
  return [...new Set(ds)].sort();
}

/** The datasets a transform reads, in name order (its In: one, unless miswired). */
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

export function checkConnection(graph: GraphLike, transformers: Transformers, source: string, target: string): Check {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const s = byId.get(source);
  const t = byId.get(target);
  if (!s || !t) return { ok: false, kind: "kind", reason: "unknown node" };
  if (s.kind === "transformer" && t.kind === "transformer") {
    return { ok: false, kind: "kind", reason: `${source} -> ${target}: transforms connect through a dataset; drop a dataset between them` };
  }
  if (s.kind === "dataset" && t.kind === "dataset") {
    return { ok: false, kind: "kind", reason: "datasets connect through a transform" };
  }
  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, kind: "duplicate", reason: "already connected" };
  }
  if (s.kind === "transformer") {
    const ds = t.dataset!;
    const writes = outputsOf(graph, source);
    if (writes.length) {
      return { ok: false, kind: "single", reason: `Transforms.${source}.Out: ${source} already writes ${writes[0]}; a transform writes one dataset` };
    }
    if (inputsOf(graph, source).includes(ds)) {
      return { ok: false, kind: "self", reason: `Transforms.${source}: reads and writes ${ds}` };
    }
    const out = emits(s, transformers);
    const carried = datasetSchema(t);
    if (out && carried && out !== carried) {
      return { ok: false, kind: "type", reason: `Transforms.${source}.Out: ${source} writes ${out} but ${ds} carries ${carried}` };
    }
  } else {
    const ds = s.dataset!;
    const reads = inputsOf(graph, target);
    if (reads.length) {
      return { ok: false, kind: "single", reason: `Transforms.${target}.In: ${target} already reads ${reads[0]}; a transform reads one dataset` };
    }
    if (outputsOf(graph, target).includes(ds)) {
      return { ok: false, kind: "self", reason: `Transforms.${target}: reads and writes ${ds}` };
    }
    const carried = datasetSchema(s);
    const want = expects(t, transformers);
    if (carried && want && carried !== want) {
      return { ok: false, kind: "type", reason: `Transforms.${target}.In: ${ds} carries ${carried} but ${target} reads ${want}` };
    }
  }
  if (reaches(graph.edges, target, source)) {
    return { ok: false, kind: "cycle", reason: `cycle detected — ${target} already feeds ${source}` };
  }
  return { ok: true };
}

/** The short form shown in the drag tooltip: "Input carries XmlPackets but Decode reads Packets". */
export function shortReason(reason: string): string {
  return reason.replace(/^Transforms\.[^:]+: /, "");
}
