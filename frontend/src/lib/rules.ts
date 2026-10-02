// Connection rules for live feedback while dragging a wire. They mirror manifest.py's
// checks, worded the same way, but manifest.py stays authoritative: a refused drop asks the
// backend (manifest.py) for its message, and the top bar shows manifest.py's validation of
// the whole manifest.
//
// A wire always joins a processor and a dataset: dataset -> processor is its In,
// processor -> dataset its Out, and a processor has one of each. A processor's schemas
// are those its processor.yaml declares at its Ref.

import type { GraphEdge, GraphNode, ProcessorInfo } from "../types";
import { findInfo, versionFor } from "./versions";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Check = { ok: true } | { ok: false; reason: string; kind: RefusalKind };
export type RefusalKind = "kind" | "duplicate" | "type" | "cycle" | "self" | "single";

export type Processors = Record<string, ProcessorInfo>;

/** The schema a dataset carries (its DataSchema). */
export function datasetSchema(node: GraphNode | undefined): string | undefined {
  return node?.datasetSpec?.DataSchema || undefined;
}

/** A processor's in and out schemas: its processor.yaml at its Ref (no Ref: the default branch). */
export function processorschemas(node: GraphNode | undefined, processors: Processors): { input?: string; output?: string } {
  const v = versionFor(findInfo(node?.processor, Object.values(processors)), node?.processor?.Ref);
  return { input: v?.input ?? undefined, output: v?.output ?? undefined };
}

/** The schema a node writes: a processor's out, a dataset's own schema. */
export function emits(node: GraphNode | undefined, processors: Processors): string | undefined {
  if (!node) return undefined;
  return node.kind === "processor" ? processorschemas(node, processors).output : datasetSchema(node);
}

/** The schema a node reads: a processor's in, a dataset's own schema. */
export function expects(node: GraphNode | undefined, processors: Processors): string | undefined {
  if (!node) return undefined;
  return node.kind === "processor" ? processorschemas(node, processors).input : datasetSchema(node);
}

/** The datasets a processor writes, in name order (its Out: one, unless miswired). */
export function outputsOf(graph: GraphLike, processor: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.source === processor)
    .map((e) => byId.get(e.target))
    .filter((n) => n?.kind === "dataset")
    .map((n) => n!.dataset!);
  return [...new Set(ds)].sort();
}

/** The datasets a processor reads, in name order (its In: one, unless miswired). */
export function inputsOf(graph: GraphLike, processor: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.target === processor)
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

export function checkConnection(graph: GraphLike, processors: Processors, source: string, target: string): Check {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const s = byId.get(source);
  const t = byId.get(target);
  if (!s || !t) return { ok: false, kind: "kind", reason: "unknown node" };
  if (s.kind === "processor" && t.kind === "processor") {
    return { ok: false, kind: "kind", reason: `${source} -> ${target}: processors connect through a dataset; drop a dataset between them` };
  }
  if (s.kind === "dataset" && t.kind === "dataset") {
    return { ok: false, kind: "kind", reason: "datasets connect through a processor" };
  }
  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, kind: "duplicate", reason: "already connected" };
  }
  if (s.kind === "processor") {
    const ds = t.dataset!;
    const writes = outputsOf(graph, source);
    if (writes.length) {
      return { ok: false, kind: "single", reason: `Processors.${source}.Out: ${source} already writes ${writes[0]}; a processor writes one dataset` };
    }
    if (inputsOf(graph, source).includes(ds)) {
      return { ok: false, kind: "self", reason: `Processors.${source}: reads and writes ${ds}` };
    }
    const out = emits(s, processors);
    const carried = datasetSchema(t);
    if (out && carried && out !== carried) {
      return { ok: false, kind: "type", reason: `Processors.${source}.Out: ${source} writes ${out} but ${ds} carries ${carried}` };
    }
  } else {
    const ds = s.dataset!;
    const reads = inputsOf(graph, target);
    if (reads.length) {
      return { ok: false, kind: "single", reason: `Processors.${target}.In: ${target} already reads ${reads[0]}; a processor reads one dataset` };
    }
    if (outputsOf(graph, target).includes(ds)) {
      return { ok: false, kind: "self", reason: `Processors.${target}: reads and writes ${ds}` };
    }
    const carried = datasetSchema(s);
    const want = expects(t, processors);
    if (carried && want && carried !== want) {
      return { ok: false, kind: "type", reason: `Processors.${target}.In: ${ds} carries ${carried} but ${target} reads ${want}` };
    }
  }
  if (reaches(graph.edges, target, source)) {
    return { ok: false, kind: "cycle", reason: `cycle detected — ${target} already feeds ${source}` };
  }
  return { ok: true };
}

/** The short form shown in the drag tooltip: "Input carries XmlPackets but Decode reads Packets". */
export function shortReason(reason: string): string {
  return reason.replace(/^Processors\.[^:]+: /, "");
}
