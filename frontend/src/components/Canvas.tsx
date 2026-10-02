import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type FinalConnectionState,
  type IsValidConnection,
} from "@xyflow/react";
import { useCallback, useEffect, type DragEvent } from "react";
import { api } from "../api";
import { checkConnection } from "../lib/rules";
import { ALL_COLORS } from "../lib/schemaColor";
import { useStudio, type PEdge, type PNode } from "../store";
import type { DatasetSpec } from "../types";
import { placeDataset } from "./Datasets";
import { DatasetNode, TransformerNode } from "./PipelineNode";
import { ArrowMarkers, ConnectionLine, DragTooltip, TopicEdge } from "./TopicEdge";

export const DRAG_MIME = "application/x-foundry-transformer";
export const DATASET_MIME = "application/x-foundry-dataset";

const nodeTypes = { transformer: TransformerNode, dataset: DatasetNode };
const edgeTypes = { topic: TopicEdge };

/** Ask manifest.py (through the backend) whether source -> target is acceptable; refuse with its message. */
async function confirmEdge(source: string, target: string, localReason?: string): Promise<boolean> {
  const { graph, toast } = useStudio.getState();
  let message = localReason ?? null;
  try {
    const res = await api.checkEdge(graph(), source, target);
    if (res.ok && !localReason) return true;
    message = res.message ?? localReason ?? null;
  } catch {
    // Backend unreachable: fall back to the local rule's wording.
  }
  if (message) toast({ kind: "error", text: message, testId: "connection-refused" }, 9000);
  return false;
}

export function Canvas() {
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const loadId = useStudio((s) => s.loadId);
  const focus = useStudio((s) => s.focus);
  const onNodesChange = useStudio((s) => s.onNodesChange);
  const onEdgesChange = useStudio((s) => s.onEdgesChange);
  const flow = useReactFlow<PNode, PEdge>();

  useEffect(() => {
    // An empty (new) pipeline has nothing to fit: show it at 100% rather than zoomed all the way in.
    const t = setTimeout(
      () => (flow.getNodes().length ? flow.fitView({ padding: 0.25, duration: 200, maxZoom: 1.2 }) : flow.setViewport({ x: 0, y: 0, zoom: 1 })),
      60,
    );
    return () => clearTimeout(t);
  }, [loadId, flow]);

  useEffect(() => {
    if (focus?.nodes.length) {
      flow.fitView({ nodes: focus.nodes.map((id) => ({ id })), padding: 0.6, duration: 300, maxZoom: 1.2 });
    }
  }, [focus, flow]);

  const isValidConnection: IsValidConnection<PEdge> = useCallback(
    (c) => {
      const s = useStudio.getState();
      return checkConnection(s.graph(), s.transformers, c.source, c.target).ok;
    },
    [],
  );

  const onConnect = useCallback(async (c: Connection) => {
    if (await confirmEdge(c.source, c.target)) useStudio.getState().connect(c.source, c.target);
  }, []);

  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    // A drop on a port that refused the wire: say why, in manifest.py's words.
    if (state.isValid !== false || !state.toNode || !state.fromNode || !state.fromHandle) return;
    if (state.toNode.id === state.fromNode.id && !state.toHandle) return;
    const [source, target] =
      state.fromHandle.type === "source" ? [state.fromNode.id, state.toNode.id] : [state.toNode.id, state.fromNode.id];
    const s = useStudio.getState();
    const check = checkConnection(s.graph(), s.transformers, source, target);
    if (!check.ok && check.kind !== "duplicate") void confirmEdge(source, target, check.reason);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes(DATASET_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const s = useStudio.getState();
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const dataset = e.dataTransfer.getData(DATASET_MIME);
      if (dataset && s.meta) {
        e.preventDefault();
        const { name, spec } = JSON.parse(dataset) as { name: string; spec: DatasetSpec };
        placeDataset(name, spec, { x: p.x - 80, y: p.y - 30 });
        return;
      }
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      const { id, ref } = JSON.parse(raw) as { id: string; ref: string };
      const info = s.transformers[id];
      if (!info || !s.meta) return;
      s.addTransformer(info, ref, { x: p.x - 90, y: p.y - 40 });
    },
    [flow],
  );

  return (
    <div className="canvas" data-testid="canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <ArrowMarkers colors={ALL_COLORS} />
      <ReactFlow<PNode, PEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        connectionLineComponent={ConnectionLine}
        onPaneClick={() => useStudio.getState().setFocus(null)}
        deleteKeyCode={["Backspace", "Delete"]}
        connectionRadius={28}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background id="minor" variant={BackgroundVariant.Lines} gap={20} color="#333" lineWidth={1} />
        <Background id="major" variant={BackgroundVariant.Lines} gap={200} color="#444" lineWidth={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable maskColor="rgba(20,20,20,0.6)" nodeColor="#666" style={{ width: 150, height: 90 }} />
      </ReactFlow>
      <DragTooltip />
    </div>
  );
}
