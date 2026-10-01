import {
  Background,
  BackgroundVariant,
  Controls,
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
import { PipelineNode } from "./PipelineNode";
import { ArrowMarkers, ConnectionLine, DragTooltip, TopicEdge } from "./TopicEdge";

export const DRAG_MIME = "application/x-foundry-transformer";

const nodeTypes = { pipeline: PipelineNode };
const edgeTypes = { topic: TopicEdge };

/** Ask deploy.py (through the backend) whether source -> target is acceptable; refuse with its message. */
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
  const theme = useStudio((s) => s.theme);
  const hasMeta = useStudio((s) => s.meta !== null);
  const empty = hasMeta && !nodes.some((n) => n.data.spec.kind === "transformer");
  const onNodesChange = useStudio((s) => s.onNodesChange);
  const onEdgesChange = useStudio((s) => s.onEdgesChange);
  const flow = useReactFlow<PNode, PEdge>();

  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.12, maxZoom: 1.1, duration: 200 }), 60);
    return () => clearTimeout(t);
  }, [loadId, flow]);

  // The drawer under the canvas changes its height: keep the pipeline in view.
  const drawer = useStudio((s) => `${s.issuesOpen}:${s.drawerTab}`);
  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.12, maxZoom: 1.1, duration: 200 }), 80);
    return () => clearTimeout(t);
  }, [drawer, flow]);

  useEffect(() => {
    if (focus?.nodes.length) {
      flow.fitView({ nodes: focus.nodes.map((id) => ({ id })), padding: 0.6, duration: 300, maxZoom: 1.2 });
    }
  }, [focus, flow]);

  const isValidConnection: IsValidConnection<PEdge> = useCallback(
    (c) => checkConnection(useStudio.getState().graph(), c.source, c.target).ok,
    [],
  );

  const onConnect = useCallback(async (c: Connection) => {
    if (await confirmEdge(c.source, c.target)) useStudio.getState().connect(c.source, c.target);
  }, []);

  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    // A drop on a port that refused the wire: say why, in deploy.py's words.
    if (state.isValid !== false || !state.toNode || !state.fromNode || !state.fromHandle) return;
    if (state.toNode.id === state.fromNode.id && !state.toHandle) return;
    const [source, target] =
      state.fromHandle.type === "source" ? [state.fromNode.id, state.toNode.id] : [state.toNode.id, state.fromNode.id];
    const check = checkConnection(useStudio.getState().graph(), source, target);
    if (!check.ok) void confirmEdge(source, target, check.reason);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      const { id, ref } = JSON.parse(raw) as { id: string; ref: string };
      const s = useStudio.getState();
      const info = s.transformers[id];
      if (!info || !s.meta) return;
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
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
        colorMode={theme}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      {empty && (
        <div className="canvas-hint">
          <div className="canvas-hint-title">Add your first transformer</div>
          Drag one from the library on the left, or press <b>+</b> on it. Then wire output ports to input ports: ports
          with a matching schema light up while you drag.
        </div>
      )}
      <DragTooltip />
    </div>
  );
}
