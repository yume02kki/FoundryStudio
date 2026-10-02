// Live data stages: what each node reads and writes, and pairing a processor's input
// records with its output records. Feeds are keyed by dataset (topic) name.

import { datasetName, isDatasetNode, type FeedMessage, type FeedState, type GraphEdge, type GraphNode } from "../types";
import { feedHealth, messageTime } from "./feedHealth";
import { inputsOf, outputsOf } from "./rules";

export interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Every node in flow order: upstream first, ties by kind (datasets first) then name. */
export function stages(graph: GraphLike): string[] {
  const ids = graph.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((t) => [t, 0]));
  for (const e of graph.edges) if (indeg.has(e.target) && indeg.has(e.source)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const key = (id: string) => `${isDatasetNode(id) ? 0 : 1}${datasetName(id)}`;
  const byKey = (a: string, b: string) => key(a).localeCompare(key(b));
  const order: string[] = [];
  const ready = ids.filter((t) => indeg.get(t) === 0).sort(byKey);
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const e of graph.edges.filter((x) => x.source === t && indeg.has(x.target))) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) {
        ready.push(e.target);
        ready.sort(byKey);
      }
    }
  }
  return [...order, ...ids.filter((t) => !order.includes(t)).sort(byKey)];
}

/** The feeds a stage needs: the datasets it reads (inputs) and writes (outputs). A dataset is its own output. */
export function stageFeeds(graph: GraphLike, stage: string): { inputs: string[]; outputs: string[] } {
  if (isDatasetNode(stage)) return { inputs: [], outputs: [datasetName(stage)] };
  return { inputs: inputsOf(graph, stage), outputs: outputsOf(graph, stage) };
}

/** Every dataset on the canvas, in flow order (one feed each). */
export function liveKeys(graph: GraphLike): string[] {
  return stages(graph).filter(isDatasetNode).map(datasetName);
}

/** The dataset an edge carries: whichever end is a dataset. */
export function edgeDataset(source: string, target: string): string {
  return isDatasetNode(source) ? datasetName(source) : datasetName(target);
}

export interface StageStats {
  inRate: number; // messages/min on what the stage reads (for a dataset: itself)
  outRate: number; // messages/min on what it writes
  processed: number;
  dropped: number;
  lastAt: number | null;
  tone: "success" | "warning" | "danger" | "muted";
  label: string;
}

/** Live numbers for one stage, for the overview, the nodes and the edges. */
export function stageStats(graph: GraphLike, stage: string, feeds: Record<string, FeedState>, now: number): StageStats {
  const { inputs, outputs } = stageFeeds(graph, stage);
  const outFeeds = outputs.map((k) => feeds[k]).filter(Boolean) as FeedState[];
  const outFeed = outFeeds[0];
  const out = outFeed ? feedHealth(outFeed, now) : null;
  if (isDatasetNode(stage)) {
    return {
      inRate: out?.perMinute ?? 0, outRate: out?.perMinute ?? 0, processed: 0, dropped: 0,
      lastAt: out?.lastAt ?? null, tone: out?.tone ?? "muted", label: out?.label ?? "Off",
    };
  }
  const inFeeds = inputs.map((k) => feeds[k]).filter(Boolean) as FeedState[];
  const inRate = inFeeds.reduce((n, f) => n + feedHealth(f, now).perMinute, 0);
  // Every output gets every record, so pair against the first one that's being watched.
  const pairs = pairRecords(inFeeds.flatMap((f) => f.messages), outFeed?.messages ?? [], now);
  const dropped = pairs.filter((p) => p.status === "dropped").length;
  const processed = pairs.filter((p) => p.status === "processed").length;
  const outRate = out?.perMinute ?? 0;
  const lastAt = out?.lastAt ?? null;
  const states = [...inFeeds, ...outFeeds].map((f) => f.state);
  let tone: StageStats["tone"] = "muted";
  let label = `${inRate} in → ${outRate} out/min`;
  if (states.length === 0 || states.every((st) => st === "idle")) label = "Off";
  else if (states.includes("error")) {
    tone = "danger";
    label = "Error";
  } else if (states.includes("connecting") && !states.includes("live")) label = "Connecting…";
  else if (inRate > 0 && outRate === 0) tone = "danger"; // input arriving, nothing coming out
  else if (dropped > 0) tone = "warning";
  else if (outRate > 0) tone = "success";
  return { inRate, outRate, processed, dropped, lastAt, tone, label };
}

const JSON_ID = /"(?:guid|id|uuid)"\s*:\s*"([^"]+)"/;
const XML_ID = /<(?:guid|id|uuid)>([^<]+)<\/(?:guid|id|uuid)>/;

/** What identifies a record across topics: its Kafka key, else a guid/id field in the payload. */
export function recordId(m: FeedMessage): string | null {
  if (m.key) return m.key;
  const v = m.value ?? "";
  return JSON_ID.exec(v)?.[1] ?? XML_ID.exec(v)?.[1] ?? null;
}

export type PairStatus = "processed" | "dropped" | "pending" | "out-only" | "unkeyed";

export interface Pair {
  id: string;
  input?: FeedMessage;
  output?: FeedMessage;
  status: PairStatus;
  at: number;
}

/**
 * Pair input and output records by id. An input with no output after `dropAfterMs`
 * counts as dropped by the processor; outputs whose input isn't in view are "out-only".
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
    const status: PairStatus = output ? "processed" : now - at > dropAfterMs ? "dropped" : "pending";
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
