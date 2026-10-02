import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { autoLayout } from "./lib/layout";
import {
  datasetName,
  datasetNode,
  isDatasetNode,
  type Catalog,
  type DatasetSpec,
  type FeedMessage,
  type FeedState,
  type Graph,
  type GraphNode,
  type Health,
  type Layout,
  type PipelineListing,
  type ProcessorInfo,
  type ValidationResult,
  type WatcherStatus,
} from "./types";

const FEED_KEEP = 200;
const idleFeed = (): FeedState => ({ state: "idle", messages: [], count: 0 });

export type PipelineNodeData = { spec: GraphNode };
export type PNode = Node<PipelineNodeData, "processor" | "dataset">;
/** A connection in the store; on the canvas, one of its wires (data: the schema drawn and the connection's id). */
export type PEdge = Edge<{ schema?: string; connection?: string }, "topic">;

export interface Meta {
  name: string;
  configs: Graph["configs"];
  extra: Record<string, unknown>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warning";
  text: string;
  link?: { href: string; label: string };
  testId?: string;
}

export type Origin = { kind: "new" } | { kind: "saved"; folder: string };

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TOPIC_RE = /^[A-Za-z0-9._-]{1,249}$/;
export const edgeId = (source: string, target: string) => `${source}->${target}`;

function toPNode(spec: GraphNode, position: { x: number; y: number }): PNode {
  return { id: spec.id, type: spec.kind, position, data: { spec } };
}

/** A connection (the manifest's In/Out); the canvas draws it as one wire per schema (lib/sockets). */
function toPEdge(source: string, target: string): PEdge {
  return { id: edgeId(source, target), source, target, type: "topic" };
}

interface State {
  meta: Meta | null;
  nodes: PNode[];
  edges: PEdge[];
  origin: Origin;
  loadId: number;
  revision: number; // bumps on every change that affects the manifest
  dirty: boolean;
  focus: { nodes: string[]; edges: string[] } | null;
  validation: ValidationResult | null;
  validating: boolean;

  catalog: Catalog | null;

  processors: Record<string, ProcessorInfo>;
  changed: Record<string, { kind: "added" | "updated"; at: number }>;
  watcher: WatcherStatus | null;
  health: Health | null;
  pipelines: PipelineListing[];
  live: boolean;

  toasts: Toast[];
  bottomTab: "processors" | "datasets" | "live";
  feedsOn: boolean;
  liveStage: string | null; // the node whose data Live data shows
  feeds: Record<string, FeedState>; // by dataset name
  versionPickerFor: string | null;
  busy: "save" | null;

  graph: () => Graph;
  layout: () => Layout;
  socketOrder: Record<string, string[]>;
  orderSockets: (id: string, order: string[]) => void;
  load: (graph: Graph, layout: Layout | null, origin: Origin) => void;
  onNodesChange: (changes: NodeChange<PNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<PEdge>[]) => void;
  connect: (source: string, target: string) => void;
  addProcessor: (info: ProcessorInfo, ref: string, position: { x: number; y: number }) => string;
  addDataset: (name: string, spec: DatasetSpec, position: { x: number; y: number }) => string;
  updateSpec: (id: string, update: (spec: GraphNode) => GraphNode) => void;
  renameNode: (from: string, to: string) => string | null;
  updateMeta: (update: (meta: Meta) => Meta) => void;
  select: (ids: { nodes?: string[]; edges?: string[] }) => void;
  setFocus: (focus: State["focus"]) => void;
  markSaved: (origin: Origin) => void;

  setProcessors: (list: ProcessorInfo[]) => void;
  upsertProcessor: (info: ProcessorInfo, kind: "added" | "updated") => void;
  removeProcessor: (id: string) => void;

  feedStatus: (key: string, status: Partial<FeedState>) => void;
  feedMessage: (key: string, message: FeedMessage) => void;
  toast: (t: Omit<Toast, "id">, ttl?: number) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 0;

export const useStudio = create<State>()((set, get) => ({
  meta: null,
  nodes: [],
  edges: [],
  origin: { kind: "new" },
  loadId: 0,
  revision: 0,
  dirty: false,
  focus: null,
  validation: null,
  validating: false,

  catalog: null,

  processors: {},
  changed: {},
  watcher: null,
  health: null,
  pipelines: [],
  live: false,

  toasts: [],
  bottomTab: "processors",
  feedsOn: false,
  liveStage: null,
  feeds: {},
  versionPickerFor: null,
  busy: null,

  graph: () => {
    const { meta, nodes, edges } = get();
    return {
      name: meta?.name ?? "",
      configs: meta?.configs ?? {},
      extra: meta?.extra ?? {},
      nodes: nodes.map((n) => n.data.spec),
      edges: edges.map((e) => ({ source: e.source, target: e.target })),
    };
  },

  layout: () => {
    const { nodes, socketOrder } = get();
    const ids = new Set(nodes.map((n) => n.id));
    const sockets = Object.fromEntries(Object.entries(socketOrder).filter(([id, order]) => ids.has(id) && order.length));
    return {
      version: 1,
      positions: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
      ...(Object.keys(sockets).length ? { sockets } : {}),
    };
  },

  socketOrder: {},
  // Purely visual, like moving a node: saved in the layout, not the manifest.
  orderSockets: (id, order) => set((s) => ({ socketOrder: { ...s.socketOrder, [id]: order }, dirty: true })),

  load: (graph, layout, origin) => {
    const auto = autoLayout(graph.nodes, graph.edges);
    const pos = (id: string) => layout?.positions?.[id] ?? auto[id] ?? { x: 0, y: 0 };
    const nodes = graph.nodes.map((n) => toPNode(n, pos(n.id)));
    set((s) => ({
      meta: { name: graph.name, configs: graph.configs ?? {}, extra: graph.extra ?? {} },
      nodes,
      edges: graph.edges.map((e) => toPEdge(e.source, e.target)),
      socketOrder: layout?.sockets ?? {},
      origin,
      loadId: s.loadId + 1,
      revision: s.revision + 1,
      dirty: false,
      focus: null,
      validation: null,
    }));
  },

  onNodesChange: (changes) => {
    const structural = changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace");
    const moved = changes.some((c) => c.type === "position" && c.dragging === false);
    set((s) => {
      const nodes = applyNodeChanges(changes, s.nodes);
      const ids = new Set(nodes.map((n) => n.id));
      const edges = structural ? s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) : s.edges;
      return {
        nodes,
        edges,
        revision: structural ? s.revision + 1 : s.revision,
        dirty: s.dirty || structural || moved,
      };
    });
  },

  onEdgesChange: (changes) => {
    const structural = changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace");
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      revision: structural ? s.revision + 1 : s.revision,
      dirty: s.dirty || structural,
    }));
  },

  connect: (source, target) =>
    set((s) =>
      s.edges.some((e) => e.source === source && e.target === target)
        ? s
        : { edges: [...s.edges, toPEdge(source, target)], revision: s.revision + 1, dirty: true },
    ),

  addProcessor: (info, ref, position) => {
    const taken = new Set(get().nodes.map((n) => n.id));
    let id = info.name.replace(/[^A-Za-z0-9._-]/g, "") || "Processor";
    for (let i = 2; taken.has(id); i++) id = `${info.name}${i}`;
    // No Ref unless a version was asked for: the processor follows its default branch.
    const spec: GraphNode = {
      id,
      kind: "processor",
      processor: { Repo: info.repo, ...(info.path ? { Path: info.path } : {}), ...(ref ? { Ref: ref } : {}) },
    };
    set((s) => ({
      nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), { ...toPNode(spec, position), selected: true }],
      revision: s.revision + 1,
      dirty: true,
    }));
    return id;
  },

  addDataset: (name, datasetSpec, position) => {
    const id = datasetNode(name);
    set((s) => {
      if (s.nodes.some((n) => n.id === id)) {
        return { nodes: s.nodes.map((n) => ({ ...n, selected: n.id === id })), focus: { nodes: [id], edges: [] } };
      }
      const spec: GraphNode = { id, kind: "dataset", dataset: name, datasetSpec };
      return {
        nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), { ...toPNode(spec, position), selected: true }],
        revision: s.revision + 1,
        dirty: true,
      };
    });
    return id;
  },

  updateSpec: (id, update) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { spec: update(n.data.spec) } } : n)),
      revision: s.revision + 1,
      dirty: true,
    })),

  renameNode: (from, toName) => {
    const s = get();
    // A dataset's id is dataset:<its name>; a processor's id is its name.
    const dataset = isDatasetNode(from);
    const to = dataset ? datasetNode(toName) : toName;
    if (from === to) return null;
    if (!NAME_RE.test(toName)) return `name must match ${NAME_RE.source}`;
    if (s.nodes.some((n) => n.id === to)) return `${toName} already exists`;
    const ren = (id: string) => (id === from ? to : id);
    const renamed = (spec: GraphNode): GraphNode => ({ ...spec, id: to, ...(dataset ? { dataset: datasetName(to) } : {}) });
    const nodes = s.nodes.map((n) => (n.id === from ? { ...n, id: to, data: { spec: renamed(n.data.spec) } } : n));
    const { [from]: order, ...socketOrder } = s.socketOrder;
    set({
      nodes,
      socketOrder: order ? { ...socketOrder, [to]: order } : socketOrder,
      edges: s.edges.map((e) =>
        e.source === from || e.target === from ? { ...toPEdge(ren(e.source), ren(e.target)), selected: e.selected } : e,
      ),
      revision: s.revision + 1,
      dirty: true,
    });
    return null;
  },

  updateMeta: (update) =>
    set((s) => (s.meta ? { meta: update(s.meta), revision: s.revision + 1, dirty: true } : s)),

  select: ({ nodes = [], edges = [] }) =>
    set((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: nodes.includes(n.id) })),
      edges: s.edges.map((e) => ({ ...e, selected: edges.includes(e.id) })),
    })),

  setFocus: (focus) => set({ focus }),

  markSaved: (origin) => set({ dirty: false, origin }),

  setProcessors: (list) => set({ processors: Object.fromEntries(list.map((t) => [t.id, t])) }),

  upsertProcessor: (info, kind) =>
    set((s) => ({
      processors: { ...s.processors, [info.id]: info },
      changed: { ...s.changed, [info.id]: { kind, at: Date.now() } },
    })),

  removeProcessor: (id) =>
    set((s) => {
      const processors = { ...s.processors };
      delete processors[id];
      return { processors };
    }),

  feedStatus: (key, status) =>
    set((s) => ({ feeds: { ...s.feeds, [key]: { ...(s.feeds[key] ?? idleFeed()), ...status } } })),

  feedMessage: (key, message) =>
    set((s) => {
      const f = s.feeds[key] ?? idleFeed();
      return {
        feeds: { ...s.feeds, [key]: { ...f, messages: [message, ...f.messages].slice(0, FEED_KEEP), count: f.count + 1 } },
      };
    }),

  toast: (t, ttl = 6000) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Validation issues about a node or an edge. */
export function issuesFor(validation: ValidationResult | null, nodeId?: string, edge?: [string, string]) {
  if (!validation) return [];
  return validation.errors.filter((e) =>
    edge
      ? e.edge?.[0] === edge[0] && e.edge?.[1] === edge[1]
      : nodeId !== undefined && (e.node === nodeId || (!e.edge && e.nodes.includes(nodeId))),
  );
}
