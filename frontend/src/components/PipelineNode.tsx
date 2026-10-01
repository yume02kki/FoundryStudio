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
        style={{ ["--schema" as string]: color }}
      />
      <span className="port-label" style={{ ["--schema" as string]: color }}>
        {schema ?? "untyped"}
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
        useStudio.setState({ issuesOpen: true, drawerTab: "live" });
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

  const kindLabel = spec.kind === "source" ? "Source" : spec.kind === "output" ? "Output" : "Transform";
  const icon = spec.kind === "source" ? "⇥" : spec.kind === "output" ? "⇤" : "ƒ";
  const subtitle =
    spec.kind === "transformer"
      ? version?.label ?? spec.transformer?.Ref ?? "no version"
      : spec.sink?.Topic || "no topic";

  return (
    <div
      className={`pnode pnode-${spec.kind}${selected ? " selected" : ""}${errors.length ? " has-error" : ""}${focused ? " focused" : ""}`}
      data-testid={`node-${id}`}
      title={errors.map((e) => e.message).join("\n") || undefined}
    >
      <div className="pnode-body">
        <span className="pnode-icon" aria-hidden>
          {icon}
        </span>
        <div className="pnode-text">
          <div className="pnode-kind">
            {kindLabel}
            {spec.kind !== "transformer" && <span> · {spec.sink?.Type ?? "Kafka"}</span>}
          </div>
          <div className="pnode-title">{id}</div>
          <div className="pnode-sub">{subtitle}</div>
        </div>
        {errors.length > 0 && (
          <span className="pnode-error-count" title={errors.map((e) => e.message).join("\n")}>
            {errors.length}
          </span>
        )}
      </div>
      {(spec.kind === "source" || spec.kind === "output") && (
        <div className="pnode-activity">
          <SinkActivity sink={id as SinkId} />
        </div>
      )}
      {(info?.inferred || update || (spec.kind === "transformer" && !info)) && (
        <div className="pnode-tags">
          {update && (
            <button
              className="tag tag-update nodrag"
              data-testid={`update-${id}`}
              title={`Update available: ${update.label}. Click to pick a version.`}
              onClick={(e) => {
                e.stopPropagation();
                useStudio.setState({ versionPickerFor: id });
              }}
            >
              ↑ {update.label} available
            </button>
          )}
          {info?.inferred && (
            <span className="tag tag-warning" title={info.warnings.join("\n")}>
              Inferred types
            </span>
          )}
          {spec.kind === "transformer" && !info && (
            <span className="tag tag-muted" title="Not found among the discovered transformers">
              Unknown source
            </span>
          )}
        </div>
      )}
      <div className="pnode-ports">
        {spec.kind !== "source" ? <Port nodeId={id} port="in" schema={expects(spec)} /> : <span />}
        {spec.kind !== "output" ? <Port nodeId={id} port="out" schema={emits(spec)} /> : <span />}
      </div>
    </div>
  );
}

export const PipelineNode = memo(PipelineNodeView);
