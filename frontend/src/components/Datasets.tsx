import { useReactFlow } from "@xyflow/react";
import { useMemo, useState, type DragEvent } from "react";
import { schemaColor } from "../lib/schemaColor";
import { NAME_RE, TOPIC_RE, useStudio, type PEdge, type PNode } from "../store";
import { datasetNode } from "../types";
import { DATASET_MIME } from "./Canvas";

const ALL = "*";

/** The catalog's datasets (registered topics) by cluster: drag one onto the canvas, or register a new one. */
export function Datasets() {
  const catalog = useStudio((s) => s.catalog);
  const nodes = useStudio((s) => s.nodes);
  const updateCatalog = useStudio((s) => s.updateCatalog);
  const flow = useReactFlow<PNode, PEdge>();
  const [cluster, setCluster] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<"dataset" | "cluster" | null>(null);
  const onCanvas = useMemo(() => new Set(nodes.filter((n) => n.data.spec.kind === "dataset").map((n) => n.data.spec.dataset)), [nodes]);

  if (!catalog) return <div className="empty">Loading the catalog…</div>;
  const clusters = Object.keys(catalog.clusters);
  const q = query.trim().toLowerCase();
  const shown = Object.entries(catalog.datasets).filter(
    ([name, d]) =>
      (cluster === ALL || d.Cluster === cluster) &&
      (!q || [name, d.Schema, d.Cluster, d.Description].some((v) => String(v ?? "").toLowerCase().includes(q))),
  );

  const place = (name: string) => {
    const s = useStudio.getState();
    if (!s.meta) return;
    const box = document.querySelector(".canvas")?.getBoundingClientRect();
    const p = box
      ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
      : { x: 0, y: 0 };
    s.addDataset(name, { x: p.x - 80 + Math.random() * 40, y: p.y - 30 + Math.random() * 40 });
  };

  return (
    <div className="assets-body">
      <div className="tree" data-testid="dataset-tree">
        <div className={`tree-item tree-root${cluster === ALL ? " active" : ""}`} onClick={() => setCluster(ALL)}>
          ▾ All datasets
        </div>
        {clusters.map((c) => (
          <div
            key={c}
            className={`tree-item depth-1${cluster === c ? " active" : ""}`}
            onClick={() => setCluster(c)}
            title={String(catalog.clusters[c].Brokers ?? "")}
            data-testid={`cluster-tree-${c}`}
          >
            <span className="tree-icon">⛁</span>
            {c}{" "}
            <span className="muted">({Object.values(catalog.datasets).filter((d) => d.Cluster === c).length})</span>
          </div>
        ))}
        <div className="tree-actions">
          <button className="btn btn-small" onClick={() => setAdding("dataset")} data-testid="add-dataset">
            + Dataset
          </button>
          <button className="btn btn-small" onClick={() => setAdding("cluster")} data-testid="add-cluster">
            + Cluster
          </button>
        </div>
      </div>
      <div className="cards-pane">
        <div className="crumbs">
          {cluster === ALL ? "All datasets" : `Cluster ${cluster}`}
          <span className="crumbs-right">
            <input className="search" placeholder="Search datasets" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="dataset-search" />
          </span>
        </div>
        {adding === "dataset" && (
          <NewDataset
            clusters={clusters}
            schemas={Object.keys(catalog.schemas)}
            taken={new Set(Object.keys(catalog.datasets))}
            defaultCluster={cluster === ALL ? clusters[0] : cluster}
            onCancel={() => setAdding(null)}
            onAdd={(name, spec) => {
              updateCatalog((c) => ({ ...c, datasets: { ...c.datasets, [name]: spec } }));
              setAdding(null);
              place(name);
            }}
          />
        )}
        {adding === "cluster" && (
          <NewCluster
            taken={new Set(clusters)}
            onCancel={() => setAdding(null)}
            onAdd={(name, brokers) => {
              updateCatalog((c) => ({ ...c, clusters: { ...c.clusters, [name]: { Brokers: brokers } } }));
              setAdding(null);
              setCluster(name);
            }}
          />
        )}
        <div className="cards" data-testid="dataset-cards">
          {shown.map(([name, d]) => (
            <div
              key={name}
              className={`card dataset-card${onCanvas.has(name) ? " on-canvas" : ""}`}
              draggable
              onDragStart={(e: DragEvent) => {
                e.dataTransfer.setData(DATASET_MIME, name);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => place(name)}
              title={[d.Description, `cluster ${d.Cluster}`, "Drag onto the canvas, or double-click"].filter(Boolean).join("\n")}
              data-testid={`dataset-card-${name}`}
            >
              <div className="card-head">
                <span className="card-icon">≋</span>
                <span className="card-name mono">{name}</span>
                {onCanvas.has(name) ? (
                  <button
                    className="star"
                    title="On the canvas: show it"
                    onClick={() => {
                      useStudio.getState().select({ nodes: [datasetNode(name)] });
                      useStudio.getState().setFocus({ nodes: [datasetNode(name)], edges: [] });
                    }}
                  >
                    ◉
                  </button>
                ) : (
                  <button className="star" title="Add to the canvas" onClick={() => place(name)} data-testid={`place-${name}`}>
                    ＋
                  </button>
                )}
              </div>
              <div className="card-types">
                <span className="schema-chip" style={{ borderColor: schemaColor(d.Schema), color: schemaColor(d.Schema) }}>
                  {d.Schema ?? "?"}
                </span>{" "}
                <span className="muted">on {d.Cluster ?? "?"}</span>
              </div>
              {d.Description && <div className="card-foot muted">{d.Description}</div>}
            </div>
          ))}
          {shown.length === 0 && <div className="empty">No datasets here.</div>}
        </div>
      </div>
    </div>
  );
}

function NewDataset({
  clusters,
  schemas,
  taken,
  defaultCluster,
  onAdd,
  onCancel,
}: {
  clusters: string[];
  schemas: string[];
  taken: Set<string>;
  defaultCluster?: string;
  onAdd: (name: string, spec: { Cluster: string; Schema: string; Description?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [cluster, setCluster] = useState(defaultCluster ?? "");
  const [schema, setSchema] = useState(schemas[0] ?? "");
  const [description, setDescription] = useState("");
  const error = !name
    ? null
    : !TOPIC_RE.test(name)
      ? "not a valid Kafka topic name"
      : taken.has(name)
        ? "already in the catalog"
        : null;
  return (
    <form
      className="inline-form"
      data-testid="new-dataset"
      onSubmit={(e) => {
        e.preventDefault();
        if (name && !error && cluster && schema) onAdd(name, { Cluster: cluster, Schema: schema, ...(description ? { Description: description } : {}) });
      }}
    >
      <span className="note">Register the topic on its cluster first; deploy.py only checks it exists.</span>
      <input placeholder="topic name, as registered" value={name} onChange={(e) => setName(e.target.value.trim())} data-testid="new-dataset-name" autoFocus />
      <select value={cluster} onChange={(e) => setCluster(e.target.value)} data-testid="new-dataset-cluster">
        {clusters.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <select value={schema} onChange={(e) => setSchema(e.target.value)} data-testid="new-dataset-schema">
        {schemas.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <input placeholder="description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      {error && <span className="issue">{error}</span>}
      <button className="btn btn-small btn-primary" disabled={!name || !!error || !cluster || !schema} data-testid="new-dataset-add">
        Add
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function NewCluster({ taken, onAdd, onCancel }: { taken: Set<string>; onAdd: (name: string, brokers: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [brokers, setBrokers] = useState("");
  const error = !name ? null : !NAME_RE.test(name) ? "invalid name" : taken.has(name) ? "already exists" : null;
  return (
    <form
      className="inline-form"
      data-testid="new-cluster"
      onSubmit={(e) => {
        e.preventDefault();
        if (name && !error && brokers) onAdd(name, brokers);
      }}
    >
      <input placeholder="cluster name" value={name} onChange={(e) => setName(e.target.value.trim())} data-testid="new-cluster-name" autoFocus />
      <input placeholder="brokers, host:9092" value={brokers} onChange={(e) => setBrokers(e.target.value.trim())} data-testid="new-cluster-brokers" />
      <span className="note">Security settings: select a dataset on it and edit the cluster in the Inspector.</span>
      {error && <span className="issue">{error}</span>}
      <button className="btn btn-small btn-primary" disabled={!name || !!error || !brokers} data-testid="new-cluster-add">
        Add
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
