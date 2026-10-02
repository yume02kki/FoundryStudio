import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import { memo, type DragEvent, type HTMLAttributes } from "react";
import { checkConnection, datasetSchema, emits, expects } from "../lib/rules";
import { inputSockets, moveSocket, ordered, outputSockets, socketId } from "../lib/sockets";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, updateFor, versionFor } from "../lib/versions";
import { issuesFor, useStudio, type PNode } from "../store";
import { NodeActivity } from "./LiveData";

type PortState = "idle" | "compatible" | "incompatible" | "origin";

function usePortState(nodeId: string, port: "in" | "out"): PortState {
  const connection = useConnection();
  if (!connection.inProgress) return "idle";
  const from = connection.fromNode.id;
  const fromType = connection.fromHandle.type; // "source" = dragging from an out port
  if (from === nodeId) return (fromType === "source") === (port === "out") ? "origin" : "incompatible";
  if (fromType === "source" && port === "out") return "idle";
  if (fromType === "target" && port === "in") return "idle";
  const s = useStudio.getState();
  const [a, b] = fromType === "source" ? [from, nodeId] : [nodeId, from];
  return checkConnection(s.graph(), s.processors, a, b).ok ? "compatible" : "incompatible";
}

const SOCKET_MIME = "application/x-foundry-socket";

/** Props making a socket's label draggable onto its siblings to rearrange them (a visual choice, kept in the layout). */
function reorderable(nodeId: string, schema: string, schemas: string[]): HTMLAttributes<HTMLElement> {
  const ours = (e: DragEvent) => e.dataTransfer.types.includes(SOCKET_MIME);
  return {
    draggable: true,
    className: "nodrag nopan socket-grab",
    title: "Drag to reorder",
    onDragStart: (e) => {
      e.stopPropagation();
      e.dataTransfer.setData(SOCKET_MIME, JSON.stringify({ nodeId, schema }));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    onDrop: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const dragged = JSON.parse(e.dataTransfer.getData(SOCKET_MIME)) as { nodeId: string; schema: string };
      if (dragged.nodeId === nodeId && dragged.schema !== schema)
        useStudio.getState().orderSockets(nodeId, moveSocket(schemas, dragged.schema, schema));
    },
  };
}

function Port({ nodeId, port, schema, label = true, handle = port, testId = `port-${nodeId}-${port}`, text, title, connectable = true, labelProps }: {
  nodeId: string; port: "in" | "out"; schema?: string; label?: boolean; handle?: string; testId?: string; text?: string; title?: string;
  connectable?: boolean; labelProps?: HTMLAttributes<HTMLElement>;
}) {
  const state = usePortState(nodeId, port);
  const color = schemaColor(schema);
  return (
    <div className={`port port-${port} port-${state}`} data-testid={testId} data-schema={schema ?? ""} title={title}>
      <Handle
        id={handle}
        isConnectableEnd={connectable}
        type={port === "in" ? "target" : "source"}
        position={port === "in" ? Position.Left : Position.Right}
        className="handle"
        style={{ background: color, borderColor: color }}
      />
      {label && (
        <span {...labelProps} className={`port-label ${labelProps?.className ?? ""}`} style={{ color }}>
          {port === "in" ? "▸ " : ""}
          {text ?? schema ?? "untyped"}
          {port === "out" ? " ▸" : ""}
        </span>
      )}
    </div>
  );
}

function ProcessorNodeView({ id, data, selected }: NodeProps<PNode>) {
  const spec = data.spec;
  const validation = useStudio((s) => s.validation);
  const focus = useStudio((s) => s.focus);
  const processors = useStudio((s) => s.processors);
  const errors = issuesFor(validation, id);
  const focused = focus?.nodes.includes(id);

  const info = findInfo(spec.processor, Object.values(processors));
  const version = versionFor(info, spec.processor?.Ref);
  const update = updateFor(info, spec.processor?.Ref);
  const subtitle = spec.processor?.Ref ? version?.label ?? spec.processor.Ref : "latest (default branch)";
  const socketOrder = useStudio((s) => s.socketOrder[id]);
  const ins = ordered(inputSockets(spec, processors), socketOrder);

  return (
    <div
      className={`pnode pnode-processor${selected ? " selected" : ""}${errors.length ? " has-error" : ""}${focused ? " focused" : ""}`}
      data-testid={`node-${id}`}
      title={errors.map((e) => e.message).join("\n") || undefined}
    >
      <div className="pnode-head">
        <span className="pnode-kind">⚙ Processor</span>
        {info && info.warnings.length > 0 && (
          <span className="badge badge-warn" title={info.warnings.join("\n")}>
            ⚠
          </span>
        )}
        {!info && (
          <span className="badge badge-muted" title="Not found among discovered processors">
            ?
          </span>
        )}
        {update && (
          <button
            className="badge badge-update nodrag"
            data-testid={`update-${id}`}
            title={`Update available: ${update.label}`}
            onClick={(e) => {
              e.stopPropagation();
              useStudio.setState({ versionPickerFor: id });
            }}
          >
            ⬆ {update.label}
          </button>
        )}
      </div>
      <div className="pnode-title">{id}</div>
      <div className="pnode-sub">{subtitle}</div>
      <NodeActivity node={id} />
      <div className="pnode-ports">
        {ins.length ? (
          <div className="port-ins">
            {ins.map((s) => (
              <Port key={s} nodeId={id} port="in" handle={socketId("in", s)} testId={`port-${id}-in-${s}`} schema={s}
                labelProps={reorderable(id, s, ins)} />
            ))}
          </div>
        ) : (
          <Port nodeId={id} port="in" schema={expects(spec, processors)} />
        )}
        <Port nodeId={id} port="out" schema={emits(spec, processors)} />
      </div>
      {errors.length > 0 && <div className="pnode-errors">{errors.length} issue{errors.length > 1 ? "s" : ""}</div>}
    </div>
  );
}

/** One of the pipeline's DataSets (a Kafka topic): processors write into its left side and read from its right. */
function DatasetNodeView({ id, data, selected }: NodeProps<PNode>) {
  const name = data.spec.dataset ?? id;
  const validation = useStudio((s) => s.validation);
  const focus = useStudio((s) => s.focus);
  const errors = issuesFor(validation, id);
  const spec = data.spec.datasetSpec;
  const schema = datasetSchema(data.spec);
  const color = schemaColor(schema);
  const socketOrder = useStudio((s) => s.socketOrder[id]);
  const sockets = ordered(outputSockets(data.spec), socketOrder);

  return (
    <div
      className={`pnode pnode-dataset${sockets.length ? " pnode-dataset-rows" : ""}${selected ? " selected" : ""}${errors.length ? " has-error" : ""}${focus?.nodes.includes(id) ? " focused" : ""}${spec ? "" : " missing"}`}
      data-testid={`node-${id}`}
      style={{ borderLeftColor: color }}
      title={errors.map((e) => e.message).join("\n") || (spec?.Topic ? `Topic ${spec.Topic}` : undefined)}
    >
      {!sockets.length && <Port nodeId={id} port="in" schema={schema} label={false} />}
      <div className="dataset-body">
        <div className="pnode-head">
          <span className="pnode-kind">≋ Dataset</span>
          <span className="dataset-cluster" data-testid={`profile-${name}`}>
            {spec ? spec.Config ?? "inline" : "not defined"}
          </span>
        </div>
        <div className="pnode-title mono">{name}</div>
        <div className="dataset-topic mono muted" data-testid={`topic-${name}`}>
          {spec?.Topic ?? "no topic"}
        </div>
        {!sockets.length && (
          // With several schemas, the rows below name them.
          <div className="dataset-schema" style={{ color }} data-testid={`schema-${name}`}>
            {schema ?? "?"}
          </div>
        )}
        <NodeActivity node={id} />
        {errors.length > 0 && <div className="pnode-errors">{errors.length} issue{errors.length > 1 ? "s" : ""}</div>}
      </div>
      {!sockets.length && <Port nodeId={id} port="out" schema={schema} label={false} />}
      {sockets.length > 0 && (
        // Several schemas: a row per schema, writers of it wire in on the left, readers out on the right.
        <div className="dataset-rows">
          {sockets.map((s) => (
            <div className="dataset-row" key={s}>
              <Port nodeId={id} port="in" handle={socketId("in", s)} testId={`port-${id}-in-${s}`} schema={s} label={false} />
              <span {...reorderable(id, s, sockets)} className={`dataset-row-label ${reorderable(id, s, sockets).className}`} style={{ color: schemaColor(s) }}>{s}</span>
              <Port nodeId={id} port="out" handle={socketId("out", s)} testId={`port-${id}-out-${s}`} schema={s} label={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ProcessorNode = memo(ProcessorNodeView);
export const DatasetNode = memo(DatasetNodeView);
