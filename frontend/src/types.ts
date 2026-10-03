// Shapes shared with the backend; see backend/foundry_studio/manifest.py.
//
// On the canvas, processors and the pipeline's Kafkas (its Kafkas: topics) are both nodes; the code
// calls a Kafka node a "dataset". Every edge is a Flow entry: Kafka -> processor (it reads it) or
// processor -> Kafka (it writes it). A processor writes one Kafka and reads one, except that a flink
// processor (Runtime: flink in its processor.yaml) may read several.

export const DATASET = "dataset:";
export const datasetNode = (name: string) => `${DATASET}${name}`;
export const isDatasetNode = (id: string) => id.startsWith(DATASET);
export const datasetName = (id: string) => (isDatasetNode(id) ? id.slice(DATASET.length) : id);

export type ConnectionSettings = Record<string, string | number | boolean>;

/** A Processors: entry. Its types and Runtime come from processor.yaml at its Ref. */
export interface Processorspec {
  Repo?: string;
  Path?: string;
  Ref?: string;
  [key: string]: unknown;
}

/** A Kafkas: entry. Config names a connection profile; ConnectionSettings override it key by key. */
export interface DatasetSpec {
  Config?: string;
  AllowedTypes?: string[]; // class names in Foundry.Common.Models
  Topic?: string;
  ConnectionSettings?: ConnectionSettings;
  [key: string]: unknown;
}

export type NodeKind = "processor" | "dataset";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  processor?: Processorspec;
  dataset?: string; // its key under Kafkas, for a Kafka node
  datasetSpec?: DatasetSpec | null; // null: used in Flow but not defined under Kafkas
  comments?: string[]; // the "# ..." lines above its entry in the manifest, written back on save
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  name: string;
  configs: { Repo?: string; Ref?: string }; // ConfigRegistry: where the connection profiles come from
  nodes: GraphNode[];
  edges: GraphEdge[];
  flow?: (string | null)[]; // Flow as loaded (null: a blank line), kept on save while the edges match it
  comments?: Record<string, string>; // end-of-line comments as loaded, by key path ("Kafkas/Input")
  extra?: Record<string, unknown>;
  warnings?: string[];
}

/** What manifests refer to (read-only): connection profiles from configRegistry, type names from Foundry.Common.Models. */
export interface Catalog {
  profiles: Record<string, ConnectionSettings>; // "kafka/prod" -> its ConnectionSettings
  types: string[];
  configs: { repo: string; ref: string; commit: string } | null;
  errors: { configs?: string; types?: string };
}

export interface Layout {
  version: 1;
  positions: Record<string, { x: number; y: number }>;
  sockets?: Record<string, string[]>; // a node's socket order, by type, where it was rearranged
}

export interface Issue {
  message: string;
  node: string | null;
  edge: [string, string] | null;
  nodes: string[];
  field: string | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  manifest: string;
  summary: string | null;
  sources?: string[];
  sinks?: string[];
}

export interface Version {
  ref: string;
  label: string;
  kind: "tag" | "branch";
  commit: string;
  committed_date: string | null;
  input: string | null;
  output: string | null;
  source: string;
  warnings: string[];
  web_url: string;
  runtime: "dotnet" | "flink";
}

export interface ProcessorInfo {
  id: string;
  project: string;
  path: string;
  name: string;
  description: string;
  repo: string;
  web_url: string;
  input: string | null;
  output: string | null;
  warnings: string[];
  latest: string;
  head: string;
  versions: Version[];
  runtime: "dotnet" | "flink";
}

export interface WatcherStatus {
  mode: string;
  pollInterval: number;
  lastPoll: number | null;
  lastWebhook: number | null;
  errors: Record<string, string>;
  projects: string[];
  scope?: "fixed" | "membership";
  withProcessors?: string[];
  ready: boolean;
}

export interface Health {
  mode: "demo" | "gitlab";
  gitlabUrl: string;
  tokenConfigured: boolean;
  webhookConfigured: boolean;
  scriptsCommit: string | null;
  workspace: string;
  configsRepo: string;
  modelsRepo: string;
  processorProjects: string[];
  watcher: WatcherStatus;
}

export interface PipelineListing {
  folder: string;
  name: string;
}

/** A Kafkas entry of some pipeline in the workspace. */
export interface WorkspaceDataset {
  folder: string;
  pipeline: string;
  name: string;
  spec: DatasetSpec;
}

export interface LoadedPipeline {
  graph: Graph;
  layout: Layout | null;
  manifest: string;
  path: string;
  folder: string;
}

export interface FeedMessage {
  partition: number;
  offset: number;
  timestamp: string | null;
  key: string | null;
  value: string | null;
  encoding: "text" | "base64" | "none";
  truncated: boolean;
  size: number;
  check: { ok: boolean | null; detail: string };
  receivedAt: number;
}

export interface FeedState {
  state: "idle" | "connecting" | "live" | "error";
  topic?: string;
  schema?: string | null;
  cluster?: string;
  message?: string;
  demo?: boolean;
  partitions?: number;
  messages: FeedMessage[]; // newest first
  count: number;
  recent?: number[]; // times of the messages produced in the last minute, beyond the ones kept
}
