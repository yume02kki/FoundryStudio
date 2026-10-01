import { useEffect, useState, type ReactNode } from "react";
import { emits } from "../lib/rules";
import { writerKey } from "../lib/stages";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, headVersion, versionFor } from "../lib/versions";
import { issuesFor, NAME_RE, useStudio } from "../store";
import { SINK, SOURCE, type ConnectionSettings, type GraphNode, type Issue } from "../types";

// Keys the transformer runtime understands (deploy.py's CONNECTION_KEYS). Keys with a
// "." go to librdkafka verbatim. There is deliberately no password field: credentials
// are referenced by name through SecretRef.
const PROTOCOLS = ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"];
const MECHANISMS = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER", "GSSAPI"];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label" title={hint}>
        {label}
      </span>
      <span className="field-input">{children}</span>
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <input
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      spellCheck={false}
    />
  );
}

function Select({
  value,
  options,
  onChange,
  testId,
  allowEmpty = true,
}: {
  value: string | undefined;
  options: string[];
  onChange: (v: string) => void;
  testId?: string;
  allowEmpty?: boolean;
}) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      {allowEmpty && <option value="">—</option>}
      {opts.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <div className="issues">
      {issues.map((i) => (
        <div key={i.message} className="issue">
          {i.message}
        </div>
      ))}
    </div>
  );
}

function ConnectionEditor({
  value,
  onChange,
  prefix,
}: {
  value: ConnectionSettings | undefined;
  onChange: (v: ConnectionSettings) => void;
  prefix: string;
}) {
  const settings = value ?? {};
  const set = (key: string, v: string | undefined) => {
    const next = { ...settings };
    if (v === undefined || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const extra = Object.keys(settings).filter(
    (k) => !["Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef", "ConsumerGroup"].includes(k),
  );
  const [newKey, setNewKey] = useState("");
  const str = (k: string) => (settings[k] === undefined ? undefined : String(settings[k]));

  return (
    <div className="conn">
      <Field label="Brokers">
        <TextInput value={str("Brokers")} onChange={(v) => set("Brokers", v)} placeholder="host:9092" testId={`${prefix}-brokers`} />
      </Field>
      <Field label="SecurityProtocol">
        <Select value={str("SecurityProtocol")} options={PROTOCOLS} onChange={(v) => set("SecurityProtocol", v)} testId={`${prefix}-protocol`} />
      </Field>
      <Field label="SaslMechanism">
        <Select value={str("SaslMechanism")} options={MECHANISMS} onChange={(v) => set("SaslMechanism", v)} testId={`${prefix}-mechanism`} />
      </Field>
      <Field label="SecretRef" hint="Name of the secret holding the credentials. Credentials themselves never go in the manifest.">
        <TextInput value={str("SecretRef")} onChange={(v) => set("SecretRef", v)} placeholder="secret name" testId={`${prefix}-secretref`} />
      </Field>
      <Field label="ConsumerGroup">
        <TextInput value={str("ConsumerGroup")} onChange={(v) => set("ConsumerGroup", v)} testId={`${prefix}-group`} />
      </Field>
      {extra.map((k) => (
        <Field key={k} label={k} hint="Passed to librdkafka verbatim">
          <span className="row">
            <TextInput value={str(k)} onChange={(v) => set(k, v)} />
            <button className="icon-btn" onClick={() => set(k, undefined)} title="Remove">
              ✕
            </button>
          </span>
        </Field>
      ))}
      <div className="add-key">
        <input
          placeholder="librdkafka key, e.g. socket.timeout.ms"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.trim())}
        />
        <button
          disabled={!newKey || newKey in settings}
          title="Keys containing '.' are passed to librdkafka; deploy.py rejects other unknown keys"
          onClick={() => {
            onChange({ ...settings, [newKey]: "" });
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SinkInspector({ node }: { node: GraphNode }) {
  const updateSpec = useStudio((s) => s.updateSpec);
  const schemaMap = useStudio((s) => s.meta?.schemas);
  const schemas = Object.keys(schemaMap ?? {});
  const validation = useStudio((s) => s.validation);
  const sink = node.sink ?? {};
  const update = (patch: Record<string, unknown>) =>
    updateSpec(node.id, (n) => ({ ...n, sink: { ...(n.sink ?? {}), ...patch } }));
  const prefix = node.id === SOURCE ? "source" : "output";

  return (
    <>
      <h3>
        {node.id === SOURCE ? "Source" : "Output"} <span className="muted">· {node.id}</span>
      </h3>
      <p className="note">External system: connected to, never created or deleted by the pipeline. Doesn't inherit Defaults.</p>
      <Issues issues={issuesFor(validation, node.id)} />
      <Field label="Type">
        <Select value={sink.Type ?? "Kafka"} options={["Kafka"]} onChange={(v) => update({ Type: v })} allowEmpty={false} />
      </Field>
      <Field label="Topic">
        <TextInput value={sink.Topic} onChange={(v) => update({ Topic: v })} testId={`${prefix}-topic`} />
      </Field>
      <Field label="Ontology">
        <Select value={sink.Ontology} options={schemas} onChange={(v) => update({ Ontology: v })} testId={`${prefix}-ontology`} />
      </Field>
      <h4>Connection settings</h4>
      <ConnectionEditor value={sink.ConnectionSettings} onChange={(v) => update({ ConnectionSettings: v })} prefix={prefix} />
    </>
  );
}

function TransformerInspector({ node }: { node: GraphNode }) {
  const updateSpec = useStudio((s) => s.updateSpec);
  const renameNode = useStudio((s) => s.renameNode);
  const transformers = useStudio((s) => s.transformers);
  const validation = useStudio((s) => s.validation);
  const spec = node.transformer ?? {};
  const info = findInfo(spec, Object.values(transformers));
  const version = versionFor(info, spec.Ref);
  const [name, setName] = useState(node.id);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => setName(node.id), [node.id]);

  const commitUrl = info && version ? info.web_url.replace(/\/-\/tree\/.*$/, `/-/commit/${version.commit}`) : null;
  const typesDiffer = version && (version.input !== spec.IN || version.output !== spec.OUT);

  return (
    <>
      <h3>
        Transformer <span className="muted">· {node.id}</span>
      </h3>
      <Issues issues={issuesFor(validation, node.id)} />
      <Field label="Name" hint="Key under Transformers: in the manifest">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(NAME_RE.test(e.target.value) ? null : "invalid name");
          }}
          onBlur={() => setNameError(renameNode(node.id, name))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      {nameError && <div className="issue">{nameError}</div>}
      <Field label="Repo">
        <input value={spec.Repo ?? ""} readOnly />
      </Field>
      <Field label="Path">
        <input value={spec.Path ?? ""} readOnly />
      </Field>
      <Field label="Version (Ref)">
        {info ? (
          <select
            value={spec.Ref ?? ""}
            data-testid="inspector-ref"
            onChange={(e) => {
              const ref = e.target.value;
              const v = ref ? info.versions.find((x) => x.ref === ref) : headVersion(info);
              updateSpec(node.id, (n) => {
                const { Ref: _old, ...rest } = n.transformer ?? {};
                return {
                  ...n,
                  transformer: { ...rest, ...(ref ? { Ref: ref } : {}), IN: v?.input ?? rest.IN, OUT: v?.output ?? rest.OUT },
                };
              });
            }}
          >
            <option value="">Default branch (latest)</option>
            {!version && spec.Ref && <option value={spec.Ref}>{spec.Ref} (not found)</option>}
            {info.versions
              .filter((v) => v.kind === "tag")
              .map((v) => (
                <option key={v.ref} value={v.ref}>
                  {v.label}
                </option>
              ))}
            {info.versions
              .filter((v) => v.kind === "branch")
              .map((v) => (
                <option key={v.ref} value={v.ref}>
                  {v.label} (pinned commit)
                </option>
              ))}
          </select>
        ) : (
          <input value={spec.Ref ?? ""} readOnly />
        )}
      </Field>
      <Field label="In">
        <span className="schema-chip" style={{ color: schemaColor(spec.IN), borderColor: schemaColor(spec.IN) }}>
          {spec.IN ?? "?"}
        </span>
      </Field>
      <Field label="Out">
        <span className="schema-chip" style={{ color: schemaColor(spec.OUT), borderColor: schemaColor(spec.OUT) }}>
          {spec.OUT ?? "?"}
        </span>
      </Field>
      {typesDiffer && (
        <div className="issue warn">
          This version declares {version.input ?? "?"} → {version.output ?? "?"}; the manifest says {spec.IN} → {spec.OUT}.
        </div>
      )}
      {version?.warnings.map((w) => (
        <div key={w} className="issue warn">
          ⚠ {w}
        </div>
      ))}
      {commitUrl && (
        <p>
          <a href={commitUrl} target="_blank" rel="noreferrer">
            Commit {version!.commit.slice(0, 8)} on GitLab ↗
          </a>
        </p>
      )}
      {!info && <p className="note">Not found among the discovered transformers; the Ref can't be checked.</p>}
    </>
  );
}

/**
 * A connection is a Kafka topic: the one its source node writes (deploy.py's endpoint_id).
 * Its connection settings live where the manifest keeps them: on the sink for InputSink /
 * OutputSink topics, and in Defaults.InternalDatasets for the topics between transformers,
 * which all internal topics share.
 */
function EdgeInspector({ id }: { id: string }) {
  const validation = useStudio((s) => s.validation);
  const [source, target] = id.split("->");
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const meta = useStudio((s) => s.meta);
  const updateSpec = useStudio((s) => s.updateSpec);
  const updateMeta = useStudio((s) => s.updateMeta);
  const graph = { nodes: nodes.map((n) => n.data.spec), edges: edges.map((e) => ({ source: e.source, target: e.target })) };
  const writer = writerKey(graph, source);
  const schema = emits(nodes.find((n) => n.id === source)?.data.spec);
  const external = writer === SOURCE || writer === SINK;
  const sink = external ? nodes.find((n) => n.id === writer)?.data.spec.sink : undefined;
  const internal = meta?.defaults.InternalDatasets ?? {};
  const internalEdges = graph.edges.filter((e) => e.source !== SOURCE && writerKey(graph, e.source) !== SINK).length;
  const sinkEdges = graph.edges.filter((e) => writerKey(graph, e.source) === writer).length;

  const settings = external ? sink?.ConnectionSettings : internal.ConnectionSettings;
  const setSettings = (v: ConnectionSettings) =>
    external
      ? updateSpec(writer, (n) => ({ ...n, sink: { ...(n.sink ?? {}), ConnectionSettings: v } }))
      : updateMeta((m) => ({
          ...m,
          defaults: { ...m.defaults, InternalDatasets: { ...(m.defaults.InternalDatasets ?? {}), ConnectionSettings: v } },
        }));

  return (
    <>
      <h3>
        Connection <span className="muted">· {source} → {target}</span>
      </h3>
      <Issues issues={issuesFor(validation, undefined, [source, target])} />
      <Field label="Carries">
        <span className="schema-chip" style={{ color: schemaColor(schema), borderColor: schemaColor(schema) }}>
          {schema ?? "?"}
        </span>
      </Field>
      {external ? (
        <>
          <Field label="Topic">
            <TextInput
              value={sink?.Topic}
              onChange={(v) => updateSpec(writer, (n) => ({ ...n, sink: { ...(n.sink ?? {}), Topic: v } }))}
              testId="edge-topic"
            />
          </Field>
          <p className="note">
            {writer === SOURCE ? "Source" : "Output"} topic: an external system.
            {sinkEdges > 1 ? ` These settings are ${writer}'s, shared by its ${sinkEdges} connections.` : ` These settings are ${writer}'s.`}
          </p>
        </>
      ) : (
        <>
          <Field label="Topic" hint="Generated by deploy.py from the graph">
            <input value={`${meta?.name || "<Pipeline>"}.${source}.out`} readOnly data-testid="edge-topic" />
          </Field>
          <p className="note">
            Internal topic between transformers. Connection settings are shared by all internal topics in this pipeline
            {internalEdges > 1 ? ` (${internalEdges} connections)` : ""}.
          </p>
        </>
      )}
      <h4>Kafka connection settings</h4>
      <ConnectionEditor value={settings} onChange={setSettings} prefix="edge" />
    </>
  );
}

function NothingSelected() {
  const validation = useStudio((s) => s.validation);
  const pipelineIssues = (validation?.errors ?? []).filter((e) => !e.node && !e.edge && !e.nodes.length);
  return (
    <>
      <Issues issues={pipelineIssues} />
      <p className="note">Select a node or an edge to inspect it.</p>
    </>
  );
}

export function Inspector() {
  const selectedNode = useStudio((s) => s.nodes.find((n) => n.selected));
  const selectedEdge = useStudio((s) => s.edges.find((e) => e.selected));
  let body: ReactNode;
  if (selectedNode) {
    const spec = selectedNode.data.spec;
    body = spec.id === SOURCE || spec.id === SINK ? <SinkInspector key={spec.id} node={spec} /> : <TransformerInspector key={spec.id} node={spec} />;
  } else if (selectedEdge) {
    body = <EdgeInspector id={selectedEdge.id} />;
  } else {
    body = <NothingSelected />;
  }
  return (
    <aside className="inspector" data-testid="inspector">
      <div className="panel-tabs">
        <span className="tab active">Inspector</span>
      </div>
      <div className="inspector-body">{body}</div>
    </aside>
  );
}
