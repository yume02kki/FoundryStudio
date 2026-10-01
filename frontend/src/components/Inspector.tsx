import { useEffect, useState, type ReactNode } from "react";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, versionFor } from "../lib/versions";
import { issuesFor, NAME_RE, useStudio, type Meta } from "../store";
import { SINK, SOURCE, type ConnectionSettings, type GraphNode, type InternalDatasets, type Issue } from "../types";

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

function NumberInput({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
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
              const v = info.versions.find((x) => x.ref === e.target.value);
              updateSpec(node.id, (n) => ({
                ...n,
                transformer: { ...n.transformer, Ref: e.target.value, IN: v?.input ?? n.transformer?.IN, OUT: v?.output ?? n.transformer?.OUT },
              }));
            }}
          >
            {!version && spec.Ref && <option value={spec.Ref}>{spec.Ref} (not found)</option>}
            {info.versions.map((v) => (
              <option key={v.ref} value={v.ref}>
                {v.label}
                {v.ref === info.latest ? " (latest)" : ""}
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

function EdgeInspector({ id }: { id: string }) {
  const validation = useStudio((s) => s.validation);
  const [source, target] = id.split("->");
  const topic = validation?.topics[id];
  return (
    <>
      <h3>Edge</h3>
      <p>
        {source} → {target}
      </p>
      <Issues issues={issuesFor(validation, undefined, [source, target])} />
      {topic && (
        <Field label={topic.internal ? "Internal dataset" : "External topic"}>
          <input value={topic.topic} readOnly />
        </Field>
      )}
      {topic?.internal && (
        <p className="note">Generated from the graph and owned by the pipeline; settings come from Defaults.InternalDatasets.</p>
      )}
    </>
  );
}

function PipelineInspector() {
  const meta = useStudio((s) => s.meta);
  const updateMeta = useStudio((s) => s.updateMeta);
  const validation = useStudio((s) => s.validation);
  if (!meta) return null;
  const internal: InternalDatasets = meta.defaults.InternalDatasets ?? {};
  const setInternal = (patch: Partial<InternalDatasets>) =>
    updateMeta((m: Meta) => ({ ...m, defaults: { ...m.defaults, InternalDatasets: { ...(m.defaults.InternalDatasets ?? {}), ...patch } } }));
  const pipelineIssues = (validation?.errors ?? []).filter((e) => !e.node && !e.edge && !e.nodes.length);

  return (
    <>
      <h3>Pipeline</h3>
      <Issues issues={pipelineIssues} />
      <Field label="Name">
        <TextInput value={meta.name} onChange={(v) => updateMeta((m) => ({ ...m, name: v }))} testId="pipeline-name" />
      </Field>
      <Field label="Registry" hint="Must be the PipelineDeploys container registry">
        <TextInput
          value={meta.defaults.Registry}
          onChange={(v) => updateMeta((m) => ({ ...m, defaults: { ...m.defaults, Registry: v } }))}
        />
      </Field>
      <h4>Internal datasets (defaults)</h4>
      <p className="note">Topics between transformers, generated as &lt;Pipeline&gt;.&lt;Transformer&gt;.out.</p>
      <Field label="Partitions">
        <NumberInput value={internal.Partitions} onChange={(v) => setInternal({ Partitions: v })} />
      </Field>
      <Field label="ReplicationFactor">
        <NumberInput value={internal.ReplicationFactor} onChange={(v) => setInternal({ ReplicationFactor: v })} />
      </Field>
      <Field label="RetentionMs">
        <NumberInput value={internal.RetentionMs} onChange={(v) => setInternal({ RetentionMs: v })} />
      </Field>
      <ConnectionEditor value={internal.ConnectionSettings} onChange={(v) => setInternal({ ConnectionSettings: v })} prefix="internal" />
      <h4>Schemas</h4>
      {Object.entries(meta.schemas).map(([name, file]) => (
        <Field key={name} label={name}>
          <span className="muted" style={{ color: schemaColor(name) }}>
            {file}
          </span>
        </Field>
      ))}
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
    body = <PipelineInspector />;
  }
  return (
    <aside className="inspector" data-testid="inspector">
      <div className="inspector-body">{body}</div>
    </aside>
  );
}
