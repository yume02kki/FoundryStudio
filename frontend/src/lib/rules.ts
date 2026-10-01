// Connection rules for live feedback while dragging a wire. They mirror deploy.py's
// per-edge checks, worded the same way, but deploy.py stays authoritative: a refused
// drop asks the backend (deploy.py) for its message, and the top bar shows deploy.py's
// validation of the whole manifest.

import { SINK, SOURCE, type GraphEdge, type GraphNode } from "../types";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Check = { ok: true } | { ok: false; reason: string; kind: RefusalKind };
export type RefusalKind = "direction" | "self-loop" | "duplicate" | "type" | "cycle" | "fan-out";

/** The schema a node writes (InputSink: its Ontology). */
export function emits(node: GraphNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "source") return node.sink?.Ontology || undefined;
  if (node.kind === "transformer") return node.transformer?.OUT || undefined;
  return undefined;
}

/** The schema a node reads (OutputSink: its Ontology). */
export function expects(node: GraphNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "output") return node.sink?.Ontology || undefined;
  if (node.kind === "transformer") return node.transformer?.IN || undefined;
  return undefined;
}

export function typeMismatch(source: string, target: string, emitted: string, expected: string): string {
  return `Relation '${source} -> ${target}': type mismatch — ${source} emits ${emitted} but ${target} expects ${expected}`;
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

export function checkConnection(graph: GraphLike, source: string, target: string): Check {
  const edge = `Relation '${source} -> ${target}'`;
  if (target === SOURCE) return { ok: false, kind: "direction", reason: `${edge}: ${SOURCE} cannot receive data` };
  if (source === SINK) return { ok: false, kind: "direction", reason: `${edge}: ${SINK} cannot emit data` };
  if (source === target) return { ok: false, kind: "self-loop", reason: `${edge}: self-loop` };
  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, kind: "duplicate", reason: `${edge}: duplicate edge` };
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = emits(byId.get(source));
  const inn = expects(byId.get(target));
  if (out && inn && out !== inn) {
    return { ok: false, kind: "type", reason: typeMismatch(source, target, out, inn) };
  }
  if (reaches(graph.edges, target, source)) {
    return { ok: false, kind: "cycle", reason: `Relation: cycle detected — ${target} already feeds ${source}` };
  }
  // A transformer writes one topic: the external OutputSink, or internal steps, not both.
  const downstream = graph.edges.filter((e) => e.source === source).map((e) => e.target);
  if (byId.get(source)?.kind === "transformer" && downstream.length > 0) {
    if (target === SINK || downstream.includes(SINK)) {
      const others = [...new Set([...downstream, target])].filter((n) => n !== SINK).sort();
      return {
        ok: false,
        kind: "fan-out",
        reason: `Transformers.${source}: feeds both ${SINK} and ${others.join(", ")}; a transformer writes a single topic, so it can't publish externally and feed internal steps at once`,
      };
    }
  }
  return { ok: true };
}

/** The short form shown in the drag tooltip: "XmlToJson emits EncodedPackets but OutputSink expects Packets". */
export function shortReason(reason: string): string {
  const i = reason.indexOf("type mismatch — ");
  return i >= 0 ? reason.slice(i + "type mismatch — ".length) : reason.replace(/^Relation '[^']*': /, "");
}

/**
 * The topic an edge carries, per deploy.py's endpoint_id: transformers write
 * `<Pipeline>.<Transformer>.out`, unless they feed OutputSink, which they write to directly.
 */
export function edgeTopic(
  pipeline: string,
  graph: GraphLike,
  source: string,
): { topic: string; internal: boolean } | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const node = byId.get(source);
  if (!node) return null;
  if (node.kind === "source") return { topic: node.sink?.Topic ?? "", internal: false };
  if (node.kind !== "transformer") return null;
  if (graph.edges.some((e) => e.source === source && e.target === SINK)) {
    return { topic: byId.get(SINK)?.sink?.Topic ?? "", internal: false };
  }
  return { topic: `${pipeline || "<Pipeline>"}.${source}.out`, internal: true };
}
