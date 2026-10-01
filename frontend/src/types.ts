// Shapes shared with the backend. The graph is the manifest's own sections plus
// nodes/edges for Transformers and Relation; see backend/foundry_studio/manifest.py.

export const SOURCE = "InputSink";
export const SINK = "OutputSink";

export type ConnectionSettings = Record<string, string | number | boolean>;

export interface SinkSpec {
  Type?: string;
  Ontology?: string;
  Topic?: string;
  ConnectionSettings?: ConnectionSettings;
  [key: string]: unknown;
}

export interface TransformerSpec {
  Repo?: string;
  Path?: string;
  Ref?: string;
  IN?: string;
  OUT?: string;
  [key: string]: unknown;
}

export type NodeKind = "source" | "output" | "transformer";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  sink?: SinkSpec;
  transformer?: TransformerSpec;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface InternalDatasets {
  Partitions?: number;
  ReplicationFactor?: number;
  RetentionMs?: number;
  ConnectionSettings?: ConnectionSettings;
  [key: string]: unknown;
}

export interface Defaults {
  Registry?: string;
  InternalDatasets?: InternalDatasets;
  [key: string]: unknown;
}

export interface Graph {
  name: string;
  defaults: Defaults;
  schemas: Record<string, string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  extra?: Record<string, unknown>;
  warnings?: string[];
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
  topics: Record<string, { topic: string; internal: boolean }>;
  summary: string | null;
  internalDatasets?: string[];
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
  inferred: boolean;
  warnings: string[];
  latest: string;
  head: string;
  versions: Version[];
}

export interface MergeRequest {
  iid: number;
  title: string;
  state: string;
  webUrl: string;
  sourceBranch: string;
  createdAt: string;
  pipeline: { status: string | null; webUrl: string | null } | null;
}

export interface WatcherStatus {
  mode: string;
  pollInterval: number;
  lastPoll: number | null;
  lastWebhook: number | null;
  errors: Record<string, string>;
  projects: string[];
  ready: boolean;
}

export interface Health {
  mode: "demo" | "gitlab";
  gitlabUrl: string;
  tokenConfigured: boolean;
  webhookConfigured: boolean;
  foundryCommit: string | null;
  deploysProject: string;
  transformerProjects: string[];
  watcher: WatcherStatus;
}

export interface PipelineListing {
  name: string;
  deployed: boolean;
  draft: boolean;
  error?: string;
}

export interface LoadedPipeline {
  source: "draft" | "deployed";
  graph: Graph;
  layout: Layout | null;
  manifest: string;
}

export interface DeployResult {
  status: "up_to_date" | "opened";
  mrUrl: string | null;
  branch?: string | null;
  log: string;
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
  message?: string;
  demo?: boolean;
  partitions?: number;
  messages: FeedMessage[]; // newest first
  count: number;
}

export type SinkId = "InputSink" | "OutputSink";
