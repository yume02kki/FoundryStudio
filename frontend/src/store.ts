import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { autoLayout } from "./lib/layout";
import {
  SINK,
  SOURCE,
  type Defaults,
  type Graph,
  type GraphNode,
  type Health,
  type Layout,
  type MergeRequest,
  type PipelineListing,
  type TransformerInfo,
  type ValidationResult,
  type WatcherStatus,
} from "./types";

export type PipelineNodeData = { spec: GraphNode };
export type PNode = Node<PipelineNodeData, "pipeline">;
export type PEdge = Edge<Record<string, never>, "topic">;

export interface Meta {
  name: string;
  defaults: Defaults;
  schemas: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warning";
  text: string;
  link?: { href: string; label: string };
  testId?: string;
}

export type Theme = "system" | "light" | "dark";

function loadTheme(): Theme {
  try {
    const t = localStorage.getItem("foundry-studio.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export type Origin = { kind: "new" } | { kind: "draft" | "deployed"; name: string };

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const edgeId = (source: string, target: string) => `${source}->${target}`;

function toPNode(spec: GraphNode, position: { x: number; y: number }): PNode {
  return {
    id: spec.id,
    type: "pipeline",
    position,
    data: { spec },
    deletable: spec.kind === "transformer",
  };
}

function toPEdge(source: string, target: string): PEdge {
  return { id: edgeId(source, target), source, target, sourceHandle: "out", targetHandle: "in", type: "topic" };
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

  transformers: Record<string, TransformerInfo>;
  changed: Record<string, { kind: "added" | "updated"; at: number }>;
  mr: MergeRequest | null;
  watcher: WatcherStatus | null;
  health: Health | null;
  pipelines: PipelineListing[];
  live: boolean;

  toasts: Toast[];
  theme: Theme;
  issuesOpen: boolean;
  versionPickerFor: string | null;
  deployOpen: boolean;
  busy: "save" | "deploy" | null;

  graph: () => Graph;
  layout: () => Layout;
  load: (graph: Graph, layout: Layout | null, origin: Origin) => void;
  onNodesChange: (changes: NodeChange<PNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<PEdge>[]) => void;
  connect: (source: string, target: string) => void;
  addTransformer: (info: TransformerInfo, ref: string, position: { x: number; y: number }) => string;
  updateSpec: (id: string, update: (spec: GraphNode) => GraphNode) => void;
  renameNode: (from: string, to: string) => string | null;
  updateMeta: (update: (meta: Meta) => Meta) => void;
  select: (ids: { nodes?: string[]; edges?: string[] }) => void;
  setFocus: (focus: State["focus"]) => void;
  markSaved: (origin: Origin) => void;

  setTransformers: (list: TransformerInfo[]) => void;
  upsertTransformer: (info: TransformerInfo, kind: "added" | "updated") => void;
  removeTransformer: (id: string) => void;

  setTheme: (theme: Theme) => void;
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

  transformers: {},
  changed: {},
  mr: null,
  watcher: null,
  health: null,
  pipelines: [],
  live: false,

  toasts: [],
  theme: loadTheme(),
  issuesOpen: false,
  versionPickerFor: null,
  deployOpen: false,
  busy: null,

  graph: () => {
    const { meta, nodes, edges } = get();
    return {
      name: meta?.name ?? "",
      defaults: meta?.defaults ?? {},
      schemas: meta?.schemas ?? {},
      extra: meta?.extra ?? {},
      nodes: nodes.map((n) => n.data.spec),
      edges: edges.map((e) => ({ source: e.source, target: e.target })),
    };
  },

  layout: () => ({
    version: 1,
    positions: Object.fromEntries(
      get().nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]),
    ),
  }),

  load: (graph, layout, origin) => {
    const auto = autoLayout(graph.nodes, graph.edges);
    const pos = (id: string) => layout?.positions?.[id] ?? auto[id] ?? { x: 0, y: 0 };
    set((s) => ({
      meta: { name: graph.name, defaults: graph.defaults ?? {}, schemas: graph.schemas ?? {}, extra: graph.extra ?? {} },
      nodes: graph.nodes.map((n) => toPNode(n, pos(n.id))),
      edges: graph.edges.map((e) => toPEdge(e.source, e.target)),
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

  addTransformer: (info, ref, position) => {
    const taken = new Set(get().nodes.map((n) => n.id));
    let id = info.name.replace(/[^A-Za-z0-9._-]/g, "") || "Transformer";
    for (let i = 2; taken.has(id) || id === SOURCE || id === SINK; i++) id = `${info.name}${i}`;
    const version = info.versions.find((v) => v.ref === ref) ?? info.versions[0];
    const spec: GraphNode = {
      id,
      kind: "transformer",
      transformer: {
        Repo: info.repo,
        ...(info.path ? { Path: info.path } : {}),
        Ref: version?.ref ?? ref,
        IN: version?.input ?? info.input ?? undefined,
        OUT: version?.output ?? info.output ?? undefined,
      },
    };
    set((s) => ({
      nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), { ...toPNode(spec, position), selected: true }],
      revision: s.revision + 1,
      dirty: true,
    }));
    return id;
  },

  updateSpec: (id, update) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { spec: update(n.data.spec) } } : n)),
      revision: s.revision + 1,
      dirty: true,
    })),

  renameNode: (from, to) => {
    const s = get();
    if (from === to) return null;
    if (!NAME_RE.test(to)) return `name must match ${NAME_RE.source}`;
    if (to === SOURCE || to === SINK) return "name is reserved";
    if (s.nodes.some((n) => n.id === to)) return `${to} already exists`;
    const ren = (id: string) => (id === from ? to : id);
    set({
      nodes: s.nodes.map((n) => (n.id === from ? { ...n, id: to, data: { spec: { ...n.data.spec, id: to } } } : n)),
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

  setTransformers: (list) => set({ transformers: Object.fromEntries(list.map((t) => [t.id, t])) }),

  upsertTransformer: (info, kind) =>
    set((s) => ({
      transformers: { ...s.transformers, [info.id]: info },
      changed: { ...s.changed, [info.id]: { kind, at: Date.now() } },
    })),

  removeTransformer: (id) =>
    set((s) => {
      const transformers = { ...s.transformers };
      delete transformers[id];
      return { transformers };
    }),

  setTheme: (theme) => {
    try {
      localStorage.setItem("foundry-studio.theme", theme);
    } catch {
      /* not persisted */
    }
    set({ theme });
  },

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
