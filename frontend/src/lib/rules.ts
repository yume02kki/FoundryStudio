// Connection rules for live feedback while dragging a wire. They mirror scripts' validators
// (validators/pipelines/typecheck.py), worded the same way, but those stay authoritative: a refused
// drop asks the backend for their message, and the top bar shows their validation of the whole
// manifest.
//
// A wire is a Flow entry and always joins a processor and a Kafka: Kafka -> processor (it reads it),
// processor -> Kafka (it writes it). A processor writes one Kafka and, unless its Runtime is flink,
// reads one. Its types (in, out) and Runtime are those its processor.yaml declares at its Ref.
// "Schema" in the names below means a type: a class name from Foundry.Common.Models.

import type { GraphEdge, GraphNode, ProcessorInfo } from "../types";
import { findInfo, versionFor } from "./versions";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Check = { ok: true } | { ok: false; reason: string; kind: RefusalKind };
export type RefusalKind = "kind" | "duplicate" | "type" | "cycle" | "self" | "single";

export type Processors = Record<string, ProcessorInfo>;

/** A list of types, or "A | B" as processor.yaml lists show: undefined for none. */
export function schemaList(value: string | string[] | null | undefined): string[] | undefined {
  const list = Array.isArray(value) ? value.map(String) : value ? value.split(" | ") : [];
  return list.length ? list : undefined;
}

/** How a schema or list of them is shown: "A | B". */
export function schemaLabel(value: string | string[] | null | undefined): string | undefined {
  return Array.isArray(value) ? value.join(" | ") : value || undefined;
}

/** The types a Kafka allows (its AllowedTypes), as a label; undefined for none. */
export function datasetSchema(node: GraphNode | undefined): string | undefined {
  return schemaList(node?.datasetSpec?.AllowedTypes)?.join(" | ");
}

/** A processor's Runtime, from its processor.yaml at its Ref (dotnet when unknown). */
export function runtimeOf(node: GraphNode | undefined, processors: Processors): "dotnet" | "flink" {
  return versionFor(findInfo(node?.processor, Object.values(processors)), node?.processor?.Ref)?.runtime ?? "dotnet";
}

/** A processor's in and out schemas: its processor.yaml at its Ref (no Ref: the default branch). */
export function processorschemas(node: GraphNode | undefined, processors: Processors): { input?: string; output?: string } {
  const v = versionFor(findInfo(node?.processor, Object.values(processors)), node?.processor?.Ref);
  return { input: schemaList(v?.input)?.join(" | "), output: schemaList(v?.output)?.join(" | ") };
}

/** The types a node writes: a processor's out, a Kafka's own. */
export function emits(node: GraphNode | undefined, processors: Processors): string | undefined {
  if (!node) return undefined;
  return node.kind === "processor" ? processorschemas(node, processors).output : datasetSchema(node);
}

/** The types a node reads: a processor's in, a Kafka's own. */
export function expects(node: GraphNode | undefined, processors: Processors): string | undefined {
  if (!node) return undefined;
  return node.kind === "processor" ? processorschemas(node, processors).input : datasetSchema(node);
}

/** The Kafkas a processor writes, in name order (one, unless miswired). */
export function outputsOf(graph: GraphLike, processor: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ds = graph.edges
    .filter((e) => e.source === processor)
    .map((e) => byId.get(e.target))
    .filter((n) => n?.kind === "dataset")
    .map((n) => n!.dataset!);
  return [...new Set(ds)].sort();
}

/** The Kafkas a processor reads, in name order. */
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
    return { ok: false, kind: "kind", reason: `${source} -> ${target}: processors connect through a Kafka; drop a Kafka between them` };
  }
  if (s.kind === "dataset" && t.kind === "dataset") {
    return { ok: false, kind: "kind", reason: "Kafkas connect through a processor" };
  }
  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, kind: "duplicate", reason: "already connected" };
  }
  if (s.kind === "processor") {
    const ds = t.dataset!;
    const writes = outputsOf(graph, source);
    if (writes.length) {
      return { ok: false, kind: "single", reason: `${source}: already writes ${writes[0]}; a processor writes one Kafka` };
    }
    if (inputsOf(graph, source).includes(ds)) {
      return { ok: false, kind: "self", reason: `Flow has a cycle: ${ds} -> ${source} -> ${ds}` };
    }
    // The Kafka must allow every type the processor writes.
    const outs = schemaList(emits(s, processors));
    const allowed = schemaList(datasetSchema(t)) ?? [];
    const extra = (outs ?? []).filter((o) => !allowed.includes(o));
    if (outs && extra.length) {
      return {
        ok: false,
        kind: "type",
        reason: `Flow: ${source} -> ${ds}: ${source} writes ${[...extra].sort().join(", ")} but ${ds} allows ${[...allowed].sort().join(", ") || "nothing"}`,
      };
    }
  } else {
    const ds = s.dataset!;
    const reads = inputsOf(graph, target);
    if (reads.length && runtimeOf(t, processors) !== "flink") {
      return { ok: false, kind: "single", reason: `${target}: already reads ${reads[0]}; a dotnet processor reads one Kafka` };
    }
    if (outputsOf(graph, target).includes(ds)) {
      return { ok: false, kind: "self", reason: `Flow has a cycle: ${target} -> ${ds} -> ${target}` };
    }
    // A reader must read every type the Kafka allows.
    const allowed = schemaList(datasetSchema(s));
    const want = schemaList(expects(t, processors));
    const extra = (allowed ?? []).filter((a) => !(want ?? []).includes(a));
    if (allowed && want && extra.length) {
      return {
        ok: false,
        kind: "type",
        reason: `Flow: ${ds} -> ${target}: ${ds} allows ${[...extra].sort().join(", ")} but ${target} reads ${[...want].sort().join(", ")}`,
      };
    }
  }
  if (reaches(graph.edges, target, source)) {
    return { ok: false, kind: "cycle", reason: `cycle detected — ${target} already feeds ${source}` };
  }
  return { ok: true };
}

/** The short form shown in the drag tooltip: "Input allows XmlPackets but Decode reads Packets". */
export function shortReason(reason: string): string {
  return reason.replace(/^Flow: \S+ -> \S+: /, "").replace(/^[^\s:]+: already/, "already");
}
