import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { checkConnection, emits, expects } from "../lib/rules";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, updateFor, versionFor } from "../lib/versions";
import { feedHealth } from "../lib/feedHealth";
import { issuesFor, useStudio, type PNode } from "../store";
import type { SinkId } from "../types";
import { useNow } from "./LiveData";

type PortState = "idle" | "compatible" | "incompatible" | "origin";

function usePortState(nodeId: string, port: "in" | "out"): PortState {
  const connection = useConnection();
  if (!connection.inProgress) return "idle";
  const from = connection.fromNode.id;
  const fromType = connection.fromHandle.type; // "source" = dragging from an out port
  if (from === nodeId) return (fromType === "source") === (port === "out") ? "origin" : "incompatible";
  if (fromType === "source" && port === "out") return "idle";
  if (fromType === "target" && port === "in") return "idle";
  const graph = useStudio.getState().graph();
  const [s, t] = fromType === "source" ? [from, nodeId] : [nodeId, from];
  return checkConnection(graph, s, t).ok ? "compatible" : "incompatible";
}

function Port({ nodeId, port, schema }: { nodeId: string; port: "in" | "out"; schema?: string }) {
  const state = usePortState(nodeId, port);
  const color = schemaColor(schema);
  return (
    <div className={`port port-${port} port-${state}`} data-testid={`port-${nodeId}-${port}`} data-schema={schema ?? ""}>
      <Handle
        id={port}
        type={port === "in" ? "target" : "source"}
        position={port === "in" ? Position.Left : Position.Right}
        className="handle"
        style={{ background: color, borderColor: color }}
      />
      <span className="port-label" style={{ color }}>
        {port === "in" ? "▸ " : ""}
        {schema ?? "untyped"}
        {port === "out" ? " ▸" : ""}
      </span>
    </div>
  );
}

/** "Flowing · 12/min" on Source/Output while Live data is on; click opens the feed. */
function SinkActivity({ sink }: { sink: SinkId }) {
  const feed = useStudio((s) => s.feeds[sink]);
  const now = useNow();
  if (feed.state === "idle") return null;
  const h = feedHealth(feed, now);
  return (
    <button
      className={`activity tone-${h.tone} nodrag`}
      data-testid={`activity-${sink}`}
      title={`${h.label} — ${h.detail}`}
      onClick={(e) => {
        e.stopPropagation();
        useStudio.setState({ bottomTab: "live" });
      }}
    >
      <span className="dot" />
      {h.label}
      {h.mismatches > 0 && <span className="activity-bad"> · {h.mismatches} bad</span>}
    </button>
  );
}

function PipelineNodeView({ id, data, selected }: NodeProps<PNode>) {
  const spec = data.spec;
  const validation = useStudio((s) => s.validation);
  const focus = useStudio((s) => s.focus);
  const transformers = useStudio((s) => s.transformers);
  const errors = issuesFor(validation, id);
  const focused = focus?.nodes.includes(id);

  const info = spec.kind === "transformer" ? findInfo(spec.transformer, Object.values(transformers)) : undefined;
  const version = versionFor(info, spec.transformer?.Ref);
  const update = updateFor(info, spec.transformer?.Ref);

  const title = spec.kind === "source" ? "Source" : spec.kind === "output" ? "Output" : "Transformer";
  const subtitle =
    spec.kind === "transformer"
      ? version?.label ?? spec.transformer?.Ref ?? "no version"
      : [spec.sink?.Type ?? "Kafka", spec.sink?.Topic].filter(Boolean).join(" · ");

  return (
    <div
      className={`pnode pnode-${spec.kind}${selected ? " selected" : ""}${errors.length ? " has-error" : ""}${focused ? " focused" : ""}`}
      data-testid={`node-${id}`}
      title={errors.map((e) => e.message).join("\n") || undefined}
    >
      <div className="pnode-head">
        <span className="pnode-kind">{title}</span>
        {info?.inferred && (
          <span className="badge badge-warn" title={info.warnings.join("\n")}>
            ⚠ inferred
          </span>
        )}
        {spec.kind === "transformer" && !info && (
          <span className="badge badge-muted" title="Not found among discovered transformers">
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
      <div className="pnode-sub">{subtitle || " "}</div>
      {(spec.kind === "source" || spec.kind === "output") && <SinkActivity sink={id as SinkId} />}
      <div className="pnode-ports">
        {spec.kind !== "source" ? <Port nodeId={id} port="in" schema={expects(spec)} /> : <span />}
        {spec.kind !== "output" ? <Port nodeId={id} port="out" schema={emits(spec)} /> : <span />}
      </div>
      {errors.length > 0 && <div className="pnode-errors">{errors.length} issue{errors.length > 1 ? "s" : ""}</div>}
    </div>
  );
}

export const PipelineNode = memo(PipelineNodeView);
