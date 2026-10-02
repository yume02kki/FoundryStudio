// Shapes shared with the backend; see backend/foundry_studio/manifest.py.
//
// On the canvas, transforms and the pipeline's datasets (its DataSets: Kafka topics) are both
// nodes. An edge dataset -> transform is the transform's In; transform -> dataset its Out.
// A transform has one of each.

export const DATASET = "dataset:";
export const datasetNode = (name: string) => `${DATASET}${name}`;
export const isDatasetNode = (id: string) => id.startsWith(DATASET);
export const datasetName = (id: string) => (isDatasetNode(id) ? id.slice(DATASET.length) : id);

export type ConnectionSettings = Record<string, string | number | boolean>;

/** A Transforms: entry, without In/Out (those are its edges). Its schemas come from transformer.yaml at its Ref. */
export interface TransformerSpec {
  Repo?: string;
  Path?: string;
  Ref?: string;
  [key: string]: unknown;
}

/** A DataSets: entry. Config names a connection profile; ConnectionSettings override it key by key. */
export interface DatasetSpec {
  Type?: string;
  Config?: string;
  DataSchema?: string;
  Topic?: string;
  ConnectionSettings?: ConnectionSettings;
  [key: string]: unknown;
}

export type NodeKind = "transformer" | "dataset";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  transformer?: TransformerSpec;
  dataset?: string; // its key under DataSets, for a dataset node
  datasetSpec?: DatasetSpec | null; // null: used by a transform but not defined under DataSets
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  name: string;
  configs: { Repo?: string; Ref?: string }; // where the connection profiles come from
  nodes: GraphNode[];
  edges: GraphEdge[];
  extra?: Record<string, unknown>;
  warnings?: string[];
}

export interface SchemaInfo {
  file: string;
  format: string | null;
  fields: Record<string, string>;
}

/** What manifests refer to (read-only): connection profiles from the configs repo, schemas from foundry-models. */
export interface Catalog {
  profiles: Record<string, ConnectionSettings>; // "kafka/prod" -> its ConnectionSettings
  schemas: Record<string, SchemaInfo>;
  configs: { repo: string; ref: string; commit: string } | null;
  errors: { configs?: string; schemas?: string };
}

export interface Layout {
  version: 1;
  positions: Record<string, { x: number; y: number }>;
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
}

export interface TransformerInfo {
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
}

export interface WatcherStatus {
  mode: string;
  pollInterval: number;
  lastPoll: number | null;
  lastWebhook: number | null;
  errors: Record<string, string>;
  projects: string[];
  scope?: "fixed" | "membership";
  withTransformers?: string[];
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
  modelsProject: string;
  transformerProjects: string[];
  watcher: WatcherStatus;
}

export interface PipelineListing {
  folder: string;
  name: string;
}

/** A DataSets entry of some pipeline in the workspace. */
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
}
