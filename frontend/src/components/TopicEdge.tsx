import {
  BaseEdge,
  getBezierPath,
  useConnection,
  useReactFlow,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from "@xyflow/react";
import { checkConnection, emits, shortReason } from "../lib/rules";
import { schemaColor } from "../lib/schemaColor";
import { useEdgeFlow } from "./LiveData";
import { issuesFor, useStudio, type PEdge, type PNode } from "../store";

export function TopicEdge(props: EdgeProps<PEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const validation = useStudio((s) => s.validation);
  const focus = useStudio((s) => s.focus);
  const nodes = useStudio((s) => s.nodes);
  const processors = useStudio((s) => s.processors);

  const sourceNode = nodes.find((n) => n.id === source)?.data.spec;
  const color = schemaColor(data?.schema ?? emits(sourceNode, processors));
  const errors = issuesFor(validation, undefined, [source, target]);
  const focused = focus?.edges.includes(data?.connection ?? id);
  const stroke = errors.length ? "var(--error)" : color;

  const flow = useEdgeFlow(source, target);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke, strokeWidth: selected || focused ? 3 : 2, opacity: focused || selected ? 1 : 0.85 }}
      />
      {flow.active && !errors.length && (
        <path d={path} className="edge-flow" style={{ stroke: color }} data-testid={`flow-${id}`}>
          <title>{flow.title}</title>
        </path>
      )}
    </>
  );
}

/** The wire while dragging; red over a port that refuses it (DragTooltip says why). */
export function ConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition, connectionStatus }: ConnectionLineComponentProps<PNode>) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, targetX: toX, targetY: toY, sourcePosition: fromPosition, targetPosition: toPosition });
  const color = connectionStatus === "invalid" ? "var(--error)" : connectionStatus === "valid" ? "var(--ok)" : "#aaa";
  return (
    <g>
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 4" />
      <circle cx={toX} cy={toY} r={4} fill={color} />
    </g>
  );
}

/** Screen-space tooltip next to the hovered port explaining why it refuses the wire being dragged. */
export function DragTooltip() {
  const connection = useConnection<PNode>();
  const flow = useReactFlow();
  if (!connection.inProgress || connection.isValid !== false || !connection.toNode) return null;
  if (connection.toNode.id === connection.fromNode.id) return null;
  const st = useStudio.getState();
  const [s, t] =
    connection.fromHandle.type === "source"
      ? [connection.fromNode.id, connection.toNode.id]
      : [connection.toNode.id, connection.fromNode.id];
  const check = checkConnection(st.graph(), st.processors, s, t);
  if (check.ok) return null;
  const at = flow.flowToScreenPosition(connection.to);
  return (
    <div className="drag-tooltip" data-testid="drag-tooltip" style={{ left: at.x, top: at.y - 18 }}>
      {shortReason(check.reason)}
    </div>
  );
}
