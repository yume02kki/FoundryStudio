import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { checkConnection, datasetSchema, emits, expects, schemaList } from "../lib/rules";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, updateFor, versionFor } from "../lib/versions";
import { inputHandle, isFlink, issuesFor, useStudio, type PNode } from "../store";
import { datasetName } from "../types";
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

function Port({ nodeId, port, schema, label = true, handle = port, testId = `port-${nodeId}-${port}`, text, title, connectable = true }: {
  nodeId: string; port: "in" | "out"; schema?: string; label?: boolean; handle?: string; testId?: string; text?: string; title?: string; connectable?: boolean;
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
        <span className="port-label" style={{ color }}>
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
        {isFlink(spec) ? <FlinkInputs id={id} /> : <Port nodeId={id} port="in" schema={expects(spec, processors)} />}
        <Port nodeId={id} port="out" schema={emits(spec, processors)} />
      </div>
      {errors.length > 0 && <div className="pnode-errors">{errors.length} issue{errors.length > 1 ? "s" : ""}</div>}
    </div>
  );
}

/**
 * A flink processor's inputs, like a Blender node's: one socket per dataset it reads (showing what that dataset
 * carries), plus a spare socket to wire another, labeled with the declared input schemas no wire covers yet.
 */
function FlinkInputs({ id }: { id: string }) {
  const edges = useStudio((s) => s.edges);
  const nodes = useStudio((s) => s.nodes);
  const processors = useStudio((s) => s.processors);
  const spec = nodes.find((n) => n.id === id)?.data.spec;
  const sources = [...new Set(edges.filter((e) => e.target === id).map((e) => e.source))].sort();
  const carried = (source: string) => datasetSchema(nodes.find((n) => n.id === source)?.data.spec);
  const covered = new Set(sources.flatMap((s) => schemaList(carried(s)) ?? []));
  const missing = (schemaList(expects(spec, processors)) ?? []).filter((s) => !covered.has(s));
  return (
    <div className="port-ins">
      {sources.map((source) => (
        <Port key={source} nodeId={id} port="in" handle={inputHandle(source)} testId={`port-${id}-in-${datasetName(source)}`}
          schema={carried(source)} title={datasetName(source)} connectable={false} />
      ))}
      <Port nodeId={id} port="in" schema={missing.join(" | ") || undefined} text={missing.length ? `+ ${missing.join(" | ")}` : "+"}
        title="Wire another dataset in" />
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

  return (
    <div
      className={`pnode pnode-dataset${selected ? " selected" : ""}${errors.length ? " has-error" : ""}${focus?.nodes.includes(id) ? " focused" : ""}${spec ? "" : " missing"}`}
      data-testid={`node-${id}`}
      style={{ borderLeftColor: color }}
      title={errors.map((e) => e.message).join("\n") || (spec?.Topic ? `Topic ${spec.Topic}` : undefined)}
    >
      <Port nodeId={id} port="in" schema={schema} label={false} />
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
        <div className="dataset-schema" style={{ color }} data-testid={`schema-${name}`}>
          {schema ?? "?"}
        </div>
        <NodeActivity node={id} />
        {errors.length > 0 && <div className="pnode-errors">{errors.length} issue{errors.length > 1 ? "s" : ""}</div>}
      </div>
      <Port nodeId={id} port="out" schema={schema} label={false} />
    </div>
  );
}

export const ProcessorNode = memo(ProcessorNodeView);
export const DatasetNode = memo(DatasetNodeView);
