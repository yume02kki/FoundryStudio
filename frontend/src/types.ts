// Shapes shared with the backend; see backend/foundry_studio/manifest.py.
//
// On the canvas, transformers and datasets (registered Kafka topics from the shared
// catalog) are both nodes. An edge dataset -> transformer is one of the transformer's
// Inputs; transformer -> dataset is its Output.

export const DATASET = "dataset:";
export const datasetNode = (name: string) => `${DATASET}${name}`;
export const isDatasetNode = (id: string) => id.startsWith(DATASET);
export const datasetName = (id: string) => (isDatasetNode(id) ? id.slice(DATASET.length) : id);

export type ConnectionSettings = Record<string, string | number | boolean>;

export interface TransformerSpec {
  Repo?: string;
  Path?: string;
  Ref?: string;
  IN?: string;
  OUT?: string;
  ConsumerGroup?: string;
  [key: string]: unknown;
}

export type NodeKind = "transformer" | "dataset";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  transformer?: TransformerSpec;
  dataset?: string; // the topic's name, for a dataset node
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  name: string;
  catalog: string; // the manifest's Catalog: path, relative to the manifest
  consumerGroup: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  extra?: Record<string, unknown>;
  warnings?: string[];
}

export interface DatasetSpec {
  Cluster?: string;
  Schema?: string;
  Description?: string;
  [key: string]: unknown;
}

export interface SchemaInfo {
  file: string;
  format: string | null;
  fields: Record<string, string>;
}

/** The shared catalog (catalog.yaml): clusters, schemas, and registered topics (datasets). */
export interface Catalog {
  clusters: Record<string, ConnectionSettings>;
  schemas: Record<string, string>;
  datasets: Record<string, DatasetSpec>;
  extra?: Record<string, unknown>;
  schemaInfo?: Record<string, SchemaInfo>;
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
  inferred: boolean;
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
  foundryCommit: string | null;
  workspace: string;
  deployTarget: string | null;
  transformerProjects: string[];
  watcher: WatcherStatus;
}

/** One recorded deploy (deploy.py's history), or the pipeline's current state. */
export interface DeployRecord {
  id: string;
  action: "deploy" | "rollback" | "stop";
  at: string;
  by: string;
  from?: string;
  digest?: string;
  project?: string;
  runner?: string;
  graph?: string[];
  transformers?: Record<string, { commit: string; ref: string; image: string }>;
}

export interface PipelineListing {
  name: string;
  deploy: DeployRecord | null;
}

export interface DeployService {
  service: string;
  state: string;
  status: string;
  image: string;
}

export interface DeployHistory {
  current: DeployRecord | null;
  history: DeployRecord[];
  runner: string;
  project: string;
  services: DeployService[];
  servicesError: string | null;
}

export interface LoadedPipeline {
  graph: Graph;
  layout: Layout | null;
  manifest: string;
  path: string;
}

export type DeployEvent =
  | { type: "log"; line: string }
  | { type: "result"; status: "deployed" | "unchanged" | "rolled-back" | "stopped"; id?: string; from?: string; project?: string }
  | { type: "error"; status: number; message: string; errors: Issue[] };

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
