// Live data stages: what each node reads and writes, and pairing a transformer's input
// records with its output records.

import { SINK, SOURCE, type FeedMessage, type GraphEdge, type GraphNode } from "../types";
import { messageTime } from "./feedHealth";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The feed key for the topic a node writes. A transformer that feeds OutputSink writes
 * OutputSink's topic (deploy.py's endpoint_id), so both share the "OutputSink" feed.
 */
export function writerKey(graph: GraphLike, node: string): string {
  if (node === SOURCE || node === SINK) return node;
  return graph.edges.some((e) => e.source === node && e.target === SINK) ? SINK : node;
}

/** Stages in pipeline order: InputSink, transformers (topologically, ties by name), OutputSink. */
export function stages(graph: GraphLike): string[] {
  const transformers = graph.nodes.filter((n) => n.kind === "transformer").map((n) => n.id);
  const indeg = new Map(transformers.map((t) => [t, 0]));
  for (const e of graph.edges) if (indeg.has(e.target) && indeg.has(e.source)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const order: string[] = [];
  const ready = transformers.filter((t) => indeg.get(t) === 0).sort();
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const e of graph.edges.filter((x) => x.source === t && indeg.has(x.target))) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) {
        ready.push(e.target);
        ready.sort();
      }
    }
  }
  const rest = transformers.filter((t) => !order.includes(t)).sort();
  return [SOURCE, ...order, ...rest, SINK];
}

/** The feeds a stage needs: what it reads (inputs) and what it writes (output). */
export function stageFeeds(graph: GraphLike, stage: string): { inputs: string[]; output: string } {
  if (stage === SOURCE || stage === SINK) return { inputs: [], output: stage };
  const inputs = [...new Set(graph.edges.filter((e) => e.target === stage).map((e) => writerKey(graph, e.source)))];
  return { inputs, output: writerKey(graph, stage) };
}

const JSON_ID = /"(?:guid|id|uuid)"\s*:\s*"([^"]+)"/;
const XML_ID = /<(?:guid|id|uuid)>([^<]+)<\/(?:guid|id|uuid)>/;

/** What identifies a record across topics: its Kafka key, else a guid/id field in the payload. */
export function recordId(m: FeedMessage): string | null {
  if (m.key) return m.key;
  const v = m.value ?? "";
  return JSON_ID.exec(v)?.[1] ?? XML_ID.exec(v)?.[1] ?? null;
}

export type PairStatus = "transformed" | "dropped" | "pending" | "out-only" | "unkeyed";

export interface Pair {
  id: string;
  input?: FeedMessage;
  output?: FeedMessage;
  status: PairStatus;
  at: number;
}

/**
 * Pair input and output records by id. An input with no output after `dropAfterMs`
 * counts as dropped by the transformer; outputs whose input isn't in view are "out-only".
 */
export function pairRecords(inputs: FeedMessage[], outputs: FeedMessage[], now: number, dropAfterMs = 5000): Pair[] {
  const outById = new Map<string, FeedMessage>();
  for (const o of outputs) {
    const id = recordId(o);
    if (id && !outById.has(id)) outById.set(id, o);
  }
  const pairs: Pair[] = [];
  const used = new Set<string>();
  inputs.forEach((i, n) => {
    const id = recordId(i);
    const at = messageTime(i);
    if (!id) {
      pairs.push({ id: `in:${n}`, input: i, status: "unkeyed", at });
      return;
    }
    const output = outById.get(id);
    if (output) used.add(id);
    const status: PairStatus = output ? "transformed" : now - at > dropAfterMs ? "dropped" : "pending";
    pairs.push({ id, input: i, output, status, at });
  });
  outputs.forEach((o, n) => {
    const id = recordId(o);
    if (id && used.has(id)) return;
    if (id) used.add(id);
    pairs.push({ id: id ?? `out:${n}`, output: o, status: id ? "out-only" : "unkeyed", at: messageTime(o) });
  });
  return pairs.sort((a, b) => b.at - a.at);
}

// --------------------------------------------------------------------------- field diff

/** Top-level fields of a JSON object or a flat XML element, or null if it's neither. */
export function fieldsOf(value: string | null): { format: "JSON" | "XML"; fields: Record<string, string> } | null {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith("{")) {
    try {
      const obj = JSON.parse(v);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return {
          format: "JSON",
          fields: Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x)])),
        };
      }
    } catch {
      return null;
    }
  }
  if (v.startsWith("<")) {
    const fields: Record<string, string> = {};
    for (const m of v.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) fields[m[1]] = m[2];
    return Object.keys(fields).length ? { format: "XML", fields } : null;
  }
  return null;
}

export interface FieldDiff {
  format?: [string, string];
  changed: { field: string; before: string; after: string }[];
  added: string[];
  removed: string[];
  unchanged: string[];
}

export function diffRecords(input: string | null, output: string | null): FieldDiff | null {
  const a = fieldsOf(input);
  const b = fieldsOf(output);
  if (!a || !b) return null;
  const keys = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])];
  const d: FieldDiff = { changed: [], added: [], removed: [], unchanged: [] };
  if (a.format !== b.format) d.format = [a.format, b.format];
  for (const k of keys) {
    if (!(k in b.fields)) d.removed.push(k);
    else if (!(k in a.fields)) d.added.push(k);
    else if (a.fields[k] !== b.fields[k]) d.changed.push({ field: k, before: a.fields[k], after: b.fields[k] });
    else d.unchanged.push(k);
  }
  return d;
}
