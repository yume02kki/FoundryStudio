import { useEffect, useState, type ReactNode } from "react";
import { inputsOf, outputsOf } from "../lib/rules";
import { edgeDataset } from "../lib/stages";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, headVersion, versionFor } from "../lib/versions";
import { issuesFor, NAME_RE, useStudio } from "../store";
import { datasetName, isDatasetNode, type ConnectionSettings, type GraphNode, type Issue } from "../types";

// Keys a catalog cluster takes (deploy.py's CLUSTER_KEYS). Keys with a "." go to
// librdkafka verbatim. There is deliberately no password field: credentials are
// referenced by name through SecretRef.
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

function SchemaChip({ schema }: { schema: string | undefined | null }) {
  return (
    <span className="schema-chip" style={{ color: schemaColor(schema), borderColor: schemaColor(schema) }}>
      {schema ?? "?"}
    </span>
  );
}

export function ConnectionEditor({
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
  const extra = Object.keys(settings).filter((k) => !["Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef"].includes(k));
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
      <Field label="SecretRef" hint="Name of the secret holding the credentials. Credentials themselves never go in the catalog.">
        <TextInput value={str("SecretRef")} onChange={(v) => set("SecretRef", v)} placeholder="secret name" testId={`${prefix}-secretref`} />
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
        <input placeholder="librdkafka key, e.g. socket.timeout.ms" value={newKey} onChange={(e) => setNewKey(e.target.value.trim())} />
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

/** A catalog cluster's connection settings, shared by every dataset on it. */
function ClusterSettings({ cluster, prefix }: { cluster: string | undefined; prefix: string }) {
  const catalog = useStudio((s) => s.catalog);
  const updateCatalog = useStudio((s) => s.updateCatalog);
  if (!cluster) return null;
  if (!catalog?.clusters[cluster]) return <div className="issue">Cluster {cluster} isn't in the catalog.</div>;
  const shared = Object.values(catalog.datasets).filter((d) => d.Cluster === cluster).length;
  return (
    <>
      <h4>
        Cluster <span className="mono">{cluster}</span>
      </h4>
      <p className="note">
        Kafka connection settings from the shared catalog{shared > 1 ? `, used by ${shared} datasets` : ""}. Saved with Save.
      </p>
      <ConnectionEditor
        value={catalog.clusters[cluster]}
        onChange={(v) => updateCatalog((c) => ({ ...c, clusters: { ...c.clusters, [cluster]: v } }))}
        prefix={prefix}
      />
    </>
  );
}

function TransformerInspector({ node }: { node: GraphNode }) {
  const updateSpec = useStudio((s) => s.updateSpec);
  const renameNode = useStudio((s) => s.renameNode);
  const transformers = useStudio((s) => s.transformers);
  const validation = useStudio((s) => s.validation);
  const graph = useStudio((s) => s.graph);
  const meta = useStudio((s) => s.meta);
  useStudio((s) => s.revision); // re-render on wiring changes
  const spec = node.transformer ?? {};
  const info = findInfo(spec, Object.values(transformers));
  const version = versionFor(info, spec.Ref);
  const reads = inputsOf(graph(), node.id);
  const writes = outputsOf(graph(), node.id);
  const groupPrefix = meta?.consumerGroup || meta?.name || "<pipeline>";
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
        <SchemaChip schema={spec.IN} />
      </Field>
      <Field label="Out">
        <SchemaChip schema={spec.OUT} />
      </Field>
      <Field label="Reads">
        <span className="mono" data-testid="transformer-reads">
          {reads.join(", ") || "—"}
        </span>
      </Field>
      <Field label="Writes">
        <span className="mono" data-testid="transformer-writes">
          {writes.join(", ") || "—"}
        </span>
      </Field>
      <Field label="ConsumerGroup" hint="Prefix of this transformer's consumer group; the runtime appends .<transformer>">
        <TextInput
          value={spec.ConsumerGroup}
          placeholder={groupPrefix}
          onChange={(v) =>
            updateSpec(node.id, (n) => {
              const { ConsumerGroup: _old, ...rest } = n.transformer ?? {};
              return { ...n, transformer: v ? { ...rest, ConsumerGroup: v } : rest };
            })
          }
          testId="transformer-group"
        />
      </Field>
      <p className="note">
        Consumer group <span className="mono">{`${spec.ConsumerGroup || groupPrefix}.${node.id}`}</span>
      </p>
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

function DatasetInspector({ node }: { node: GraphNode }) {
  const name = node.dataset ?? datasetName(node.id);
  const catalog = useStudio((s) => s.catalog);
  const updateCatalog = useStudio((s) => s.updateCatalog);
  const validation = useStudio((s) => s.validation);
  const graph = useStudio((s) => s.graph);
  useStudio((s) => s.revision);
  const spec = catalog?.datasets[name];
  const clusters = Object.keys(catalog?.clusters ?? {});
  const schemas = Object.keys(catalog?.schemas ?? {});
  const info = spec?.Schema ? catalog?.schemaInfo?.[spec.Schema] : undefined;
  const g = graph();
  const transformers = g.nodes.filter((n) => n.kind === "transformer").map((n) => n.id);
  const writers = transformers.filter((t) => outputsOf(g, t).includes(name));
  const readers = transformers.filter((t) => inputsOf(g, t).includes(name));
  const set = (patch: Record<string, string>) =>
    updateCatalog((c) => {
      const next: Record<string, unknown> = { ...(c.datasets[name] ?? {}), ...patch };
      for (const k of Object.keys(patch)) if (!patch[k]) delete next[k];
      return { ...c, datasets: { ...c.datasets, [name]: next } };
    });

  return (
    <>
      <h3>
        Dataset <span className="muted mono">· {name}</span>
      </h3>
      <Issues issues={issuesFor(validation, node.id)} />
      <p className="note">
        A registered Kafka topic from the shared catalog. Pipelines read and write it; deploy.py never creates or deletes it.
      </p>
      {!spec && (
        <div className="issue" data-testid="dataset-missing">
          {name} isn't in the catalog. Pick its cluster and schema to add it.
        </div>
      )}
      <Field label="Topic">
        <input value={name} readOnly className="mono" data-testid="dataset-topic" />
      </Field>
      <Field label="Cluster">
        <Select value={spec?.Cluster} options={clusters} onChange={(v) => set({ Cluster: v })} testId="dataset-cluster" />
      </Field>
      <Field label="Schema" hint="Shared by every pipeline using this topic">
        <Select value={spec?.Schema} options={schemas} onChange={(v) => set({ Schema: v })} testId="dataset-schema" />
      </Field>
      <Field label="Description">
        <TextInput value={spec?.Description} onChange={(v) => set({ Description: v })} testId="dataset-description" />
      </Field>
      {info && (
        <div className="schema-fields" data-testid="dataset-fields">
          <div className="muted">
            {spec?.Schema}: {info.format ?? "?"} · {info.file}
          </div>
          <table>
            <tbody>
              {Object.entries(info.fields).map(([f, t]) => (
                <tr key={f}>
                  <td className="mono">{f}</td>
                  <td className="muted">{t}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Field label="Written by">
        <span className="mono">{writers.join(", ") || "outside this pipeline"}</span>
      </Field>
      <Field label="Read by">
        <span className="mono">{readers.join(", ") || "outside this pipeline"}</span>
      </Field>
      <ClusterSettings cluster={spec?.Cluster} prefix="dataset" />
    </>
  );
}

/**
 * A connection is a transformer reading or writing a dataset. Its Kafka settings are the
 * dataset's cluster's, from the shared catalog.
 */
function EdgeInspector({ id }: { id: string }) {
  const validation = useStudio((s) => s.validation);
  const edge = useStudio((s) => s.edges.find((e) => e.id === id));
  const catalog = useStudio((s) => s.catalog);
  const meta = useStudio((s) => s.meta);
  const nodes = useStudio((s) => s.nodes);
  if (!edge) return null;
  const { source, target } = edge;
  const name = edgeDataset(source, target);
  const reading = isDatasetNode(source);
  const transformer = reading ? target : source;
  const spec = catalog?.datasets[name];
  const tSpec = nodes.find((n) => n.id === transformer)?.data.spec.transformer;
  const group = `${tSpec?.ConsumerGroup || meta?.consumerGroup || meta?.name || "<pipeline>"}.${transformer}`;

  return (
    <>
      <h3>
        Connection{" "}
        <span className="muted">
          · {transformer} {reading ? "reads" : "writes"} {name}
        </span>
      </h3>
      <Issues issues={issuesFor(validation, undefined, [source, target])} />
      <Field label="Topic">
        <input value={name} readOnly className="mono" data-testid="edge-topic" />
      </Field>
      <Field label="Carries">
        <SchemaChip schema={spec?.Schema} />
      </Field>
      {reading && (
        <Field label="Consumer group" hint="<ConsumerGroup or pipeline Name>.<transformer>">
          <input value={group} readOnly className="mono" data-testid="edge-group" />
        </Field>
      )}
      <ClusterSettings cluster={spec?.Cluster} prefix="edge" />
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
    body = spec.kind === "dataset" ? <DatasetInspector key={spec.id} node={spec} /> : <TransformerInspector key={spec.id} node={spec} />;
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
