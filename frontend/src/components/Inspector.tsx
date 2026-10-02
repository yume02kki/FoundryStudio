import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { inputsOf, outputsOf, transformSchemas } from "../lib/rules";
import { edgeDataset } from "../lib/stages";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, versionFor } from "../lib/versions";
import { issuesFor, NAME_RE, TOPIC_RE, useStudio } from "../store";
import { datasetName, datasetNode, isDatasetNode, type ConnectionSettings, type DatasetSpec, type GraphNode, type Issue } from "../types";

// ConnectionSettings keys (manifest.py's CONNECTION_KEYS). There is deliberately no password
// field: credentials are referenced by name through SecretRef.
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
      <Field label="SecretRef" hint="Name of the secret holding the credentials. Credentials themselves never go in a manifest.">
        <TextInput value={str("SecretRef")} onChange={(v) => set("SecretRef", v)} placeholder="secret name" testId={`${prefix}-secretref`} />
      </Field>
    </div>
  );
}

/** A connection profile's settings, from the configs repo (read-only). */
function ProfileSettings({ profile }: { profile: string | undefined }) {
  const catalog = useStudio((s) => s.catalog);
  if (!profile) return null;
  const settings = catalog?.profiles[profile];
  if (!settings) return <div className="issue">Profile {profile} isn't in the configs repo.</div>;
  return (
    <>
      <h4>
        Profile <span className="mono">{profile}</span>
      </h4>
      <p className="note">From {catalog?.configs?.repo ?? "the configs repo"} (read-only).</p>
      <table className="kv" data-testid="profile-settings">
        <tbody>
          {Object.entries(settings).map(([k, v]) => (
            <tr key={k}>
              <td className="muted">{k}</td>
              <td className="mono">{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function NameField({ id, label, hint }: { id: string; label: string; hint: string }) {
  const renameNode = useStudio((s) => s.renameNode);
  const current = datasetName(id);
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(current), [current]);
  return (
    <>
      <Field label={label} hint={hint}>
        <input
          value={name}
          data-testid="inspector-name"
          onChange={(e) => {
            setName(e.target.value);
            setError(NAME_RE.test(e.target.value) ? null : "invalid name");
          }}
          onBlur={() => setError(renameNode(id, name))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      {error && <div className="issue">{error}</div>}
    </>
  );
}

function TransformerInspector({ node }: { node: GraphNode }) {
  const updateSpec = useStudio((s) => s.updateSpec);
  const transformers = useStudio((s) => s.transformers);
  const validation = useStudio((s) => s.validation);
  const graph = useStudio((s) => s.graph);
  const meta = useStudio((s) => s.meta);
  useStudio((s) => s.revision); // re-render on wiring changes
  const spec = node.transformer ?? {};
  const info = findInfo(spec, Object.values(transformers));
  const version = versionFor(info, spec.Ref);
  const { input, output } = transformSchemas(node, transformers);
  const reads = inputsOf(graph(), node.id);
  const writes = outputsOf(graph(), node.id);
  const commitUrl = info && version ? info.web_url.replace(/\/-\/tree\/.*$/, `/-/commit/${version.commit}`) : null;

  return (
    <>
      <h3>
        Transform <span className="muted">· {node.id}</span>
      </h3>
      <Issues issues={issuesFor(validation, node.id)} />
      <NameField id={node.id} label="Name" hint="Key under Transforms: in the manifest" />
      <Field label="Repo">
        <input value={spec.Repo ?? ""} readOnly />
      </Field>
      {spec.Path && (
        <Field label="Path">
          <input value={spec.Path} readOnly />
        </Field>
      )}
      <Field label="Version (Ref)">
        {info ? (
          <select
            value={spec.Ref ?? ""}
            data-testid="inspector-ref"
            onChange={(e) => {
              const ref = e.target.value;
              updateSpec(node.id, (n) => {
                const { Ref: _old, ...rest } = n.transformer ?? {};
                return { ...n, transformer: ref ? { ...rest, Ref: ref } : rest };
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
      <Field label="Reads" hint="From transformer.yaml at this version">
        <SchemaChip schema={input} />
      </Field>
      <Field label="Writes" hint="From transformer.yaml at this version">
        <SchemaChip schema={output} />
      </Field>
      <Field label="In">
        <span className="mono" data-testid="transformer-reads">
          {reads.join(", ") || "—"}
        </span>
      </Field>
      <Field label="Out">
        <span className="mono" data-testid="transformer-writes">
          {writes.join(", ") || "—"}
        </span>
      </Field>
      <p className="note">
        Consumer group <span className="mono">{`${meta?.name || "<pipeline>"}.${node.id}`}</span>
      </p>
      {info?.description && <p className="note">{info.description}</p>}
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
      {!info && <p className="note">Not found among the discovered transformers; its Ref and schemas can't be checked.</p>}
    </>
  );
}

function DatasetInspector({ node }: { node: GraphNode }) {
  const name = node.dataset ?? datasetName(node.id);
  const catalog = useStudio((s) => s.catalog);
  const updateSpec = useStudio((s) => s.updateSpec);
  const validation = useStudio((s) => s.validation);
  const graph = useStudio((s) => s.graph);
  useStudio((s) => s.revision);
  const spec = node.datasetSpec;
  const profiles = Object.keys(catalog?.profiles ?? {});
  const schemas = Object.keys(catalog?.schemas ?? {});
  const info = spec?.DataSchema ? catalog?.schemas[spec.DataSchema] : undefined;
  const g = graph();
  const transformers = g.nodes.filter((n) => n.kind === "transformer").map((n) => n.id);
  const writers = transformers.filter((t) => outputsOf(g, t).includes(name));
  const readers = transformers.filter((t) => inputsOf(g, t).includes(name));
  const [overrides, setOverrides] = useState(!!spec?.ConnectionSettings && Object.keys(spec.ConnectionSettings).length > 0);
  const set = (patch: Partial<DatasetSpec>) =>
    updateSpec(node.id, (n) => {
      const next: DatasetSpec = { Type: "Kafka", ...(n.datasetSpec ?? {}), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined || v === "") delete next[k];
      return { ...n, datasetSpec: next };
    });

  return (
    <>
      <h3>
        Dataset <span className="muted mono">· {name}</span>
      </h3>
      <Issues issues={issuesFor(validation, node.id)} />
      <p className="note">A Kafka topic this pipeline reads or writes. It must already exist; nothing here creates or deletes one.</p>
      {!spec && (
        <div className="issue" data-testid="dataset-missing">
          {name} is used but not defined under DataSets. Fill in its topic, profile and schema to define it.
        </div>
      )}
      <NameField id={node.id} label="Name" hint="Key under DataSets: in the manifest" />
      <Field label="Topic">
        <input
          value={spec?.Topic ?? ""}
          className={`mono${spec?.Topic && !TOPIC_RE.test(spec.Topic) ? " invalid" : ""}`}
          onChange={(e) => set({ Topic: e.target.value.trim() })}
          data-testid="dataset-topic"
          spellCheck={false}
        />
      </Field>
      <Field label="Type">
        <Select value={spec?.Type} options={["Kafka"]} onChange={(v) => set({ Type: v })} testId="dataset-type" allowEmpty={false} />
      </Field>
      <Field label="Profile" hint="Config: a connection profile from the configs repo">
        <Select value={spec?.Config} options={profiles} onChange={(v) => set({ Config: v })} testId="dataset-profile" />
      </Field>
      <Field label="Schema" hint="DataSchema: a schema in foundry-models">
        <Select value={spec?.DataSchema} options={schemas} onChange={(v) => set({ DataSchema: v })} testId="dataset-schema" />
      </Field>
      {info && (
        <div className="schema-fields" data-testid="dataset-fields">
          <div className="muted">
            {spec?.DataSchema}: {info.format ?? "?"} · {info.file}
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
      <ProfileSettings profile={spec?.Config} />
      <label className="field">
        <span className="field-label" title="ConnectionSettings on the dataset override the profile's, key by key">
          Override
        </span>
        <span className="field-input">
          <input
            type="checkbox"
            checked={overrides}
            data-testid="dataset-override"
            onChange={(e) => {
              setOverrides(e.target.checked);
              if (!e.target.checked) set({ ConnectionSettings: undefined });
            }}
          />
        </span>
      </label>
      {overrides && (
        <ConnectionEditor
          value={spec?.ConnectionSettings}
          onChange={(v) => set({ ConnectionSettings: Object.keys(v).length ? v : undefined })}
          prefix="dataset"
        />
      )}
    </>
  );
}

/** A connection is a transform reading or writing a dataset. */
function EdgeInspector({ id }: { id: string }) {
  const validation = useStudio((s) => s.validation);
  const edge = useStudio((s) => s.edges.find((e) => e.id === id));
  const meta = useStudio((s) => s.meta);
  const nodes = useStudio((s) => s.nodes);
  if (!edge) return null;
  const { source, target } = edge;
  const name = edgeDataset(source, target);
  const reading = isDatasetNode(source);
  const transformer = reading ? target : source;
  const spec = nodes.find((n) => n.id === datasetNode(name))?.data.spec.datasetSpec;

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
        <input value={spec?.Topic ?? ""} readOnly className="mono" data-testid="edge-topic" />
      </Field>
      <Field label="Carries">
        <SchemaChip schema={spec?.DataSchema} />
      </Field>
      {reading && (
        <Field label="Consumer group" hint="<pipeline Name>.<transform>">
          <input value={`${meta?.name || "<pipeline>"}.${transformer}`} readOnly className="mono" data-testid="edge-group" />
        </Field>
      )}
      <ProfileSettings profile={spec?.Config} />
    </>
  );
}

/** Nothing selected: the pipeline's own settings and the issues that aren't about one node. */
function PipelineInspector() {
  const validation = useStudio((s) => s.validation);
  const meta = useStudio((s) => s.meta);
  const catalog = useStudio((s) => s.catalog);
  const health = useStudio((s) => s.health);
  const updateMeta = useStudio((s) => s.updateMeta);
  const pipelineIssues = (validation?.errors ?? []).filter((e) => !e.node && !e.edge && !e.nodes.length);
  if (!meta) return null;
  const setConfigs = (key: "Repo" | "Ref", value: string) =>
    updateMeta((m) => {
      const configs = { ...m.configs, [key]: value.trim() || undefined };
      if (!configs[key]) delete configs[key];
      return { ...m, configs };
    });
  const reload = async () => useStudio.setState({ catalog: await api.catalog(useStudio.getState().meta?.configs) });

  return (
    <>
      <h3>Pipeline</h3>
      <Issues issues={pipelineIssues} />
      <Field label="Configs repo" hint="Configs.Repo: where the connection profiles come from">
        <TextInput value={meta.configs.Repo} placeholder={health?.configsRepo} onChange={(v) => setConfigs("Repo", v)} testId="configs-repo" />
      </Field>
      <Field label="Configs ref" hint="Configs.Ref: a branch, tag or commit; defaults to main">
        <TextInput value={meta.configs.Ref} placeholder="main" onChange={(v) => setConfigs("Ref", v)} testId="configs-ref" />
      </Field>
      <p className="note">
        {catalog?.configs
          ? `${Object.keys(catalog.profiles).length} profiles at ${catalog.configs.commit.slice(0, 8)}. `
          : catalog?.errors.configs
            ? `Profiles: ${catalog.errors.configs}. `
            : ""}
        <button className="link-btn" onClick={() => void reload()} data-testid="reload-profiles">
          Reload
        </button>
      </p>
      <p className="note">
        Schemas from {health?.modelsProject ?? "foundry-models"}: {Object.keys(catalog?.schemas ?? {}).join(", ") || "none"}.
      </p>
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
    body = <PipelineInspector />;
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
