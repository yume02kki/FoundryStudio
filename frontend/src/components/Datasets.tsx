import { useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { api } from "../api";
import { schemaColor } from "../lib/schemaColor";
import { NAME_RE, TOPIC_RE, useStudio, type PEdge, type PNode } from "../store";
import { datasetNode, type DatasetSpec, type WorkspaceDataset } from "../types";
import { DATASET_MIME } from "./Canvas";
import { schemaLabel } from "../lib/rules";

type Filter = { kind: "pipeline" } | { kind: "others" } | { kind: "profile"; profile: string };

/**
 * Put a Kafka on the canvas. The same topic already there is just shown; a name already
 * taken by another topic gets a number.
 */
export function placeDataset(name: string, spec: DatasetSpec, position: { x: number; y: number }) {
  const s = useStudio.getState();
  if (!s.meta) return;
  const same = s.nodes.find((n) => n.data.spec.kind === "dataset" && spec.Topic && n.data.spec.datasetSpec?.Topic === spec.Topic);
  if (same) {
    s.select({ nodes: [same.id] });
    s.setFocus({ nodes: [same.id], edges: [] });
    return;
  }
  const taken = new Set(s.nodes.map((n) => n.id));
  let unique = name;
  for (let i = 2; taken.has(datasetNode(unique)); i++) unique = `${name}${i}`;
  s.addDataset(unique, spec, position);
}

function Card({ name, spec, note, onCanvas, draggable }: { name: string; spec: DatasetSpec; note?: string; onCanvas: boolean; draggable: boolean }) {
  const show = () => {
    useStudio.getState().select({ nodes: [datasetNode(name)] });
    useStudio.getState().setFocus({ nodes: [datasetNode(name)], edges: [] });
  };
  return (
    <div
      className={`card dataset-card${onCanvas ? " on-canvas" : ""}`}
      draggable={draggable}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData(DATASET_MIME, JSON.stringify({ name, spec }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onCanvas ? show : undefined}
      title={[`Topic ${spec.Topic ?? "?"}`, note, draggable ? "Drag onto the canvas to use it here" : "Click to show it"].filter(Boolean).join("\n")}
      data-testid={`dataset-card-${note ? `${note}-` : ""}${name}`}
    >
      <div className="card-head">
        <span className="card-icon">≋</span>
        <span className="card-name mono">{name}</span>
        {onCanvas && <span className="star">◉</span>}
      </div>
      <div className="card-types">
        <span className="schema-chip" style={{ borderColor: schemaColor(schemaLabel(spec.AllowedTypes)), color: schemaColor(schemaLabel(spec.AllowedTypes)) }}>
          {schemaLabel(spec.AllowedTypes) || "no types"}
        </span>{" "}
        <span className="muted mono">{spec.Topic ?? "no topic"}</span>
      </div>
      <div className="card-foot muted">
        {spec.Config ?? "inline settings"}
        {note ? ` · from ${note}` : ""}
      </div>
    </div>
  );
}

/** The pipeline's Kafkas, those other pipelines define (drag one in to reuse its topic), and the connection profiles. */
export function Datasets() {
  const catalog = useStudio((s) => s.catalog);
  const nodes = useStudio((s) => s.nodes);
  const origin = useStudio((s) => s.origin);
  const flow = useReactFlow<PNode, PEdge>();
  const [filter, setFilter] = useState<Filter>({ kind: "pipeline" });
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [others, setOthers] = useState<WorkspaceDataset[]>([]);

  useEffect(() => {
    api.datasets().then((r) => setOthers(r.datasets), () => setOthers([]));
  }, [origin]);

  const mine = useMemo(
    () => nodes.filter((n) => n.data.spec.kind === "dataset").map((n) => ({ name: n.data.spec.dataset!, spec: n.data.spec.datasetSpec ?? {} })),
    [nodes],
  );
  const topicsHere = new Set(mine.map((d) => d.spec.Topic).filter(Boolean));
  const folder = origin.kind === "saved" ? origin.folder : null;
  // Other pipelines' Kafkas, one per topic, minus those already here.
  const reusable = others.filter(
    (d, i) => d.folder !== folder && !topicsHere.has(d.spec.Topic) && others.findIndex((o) => o.spec.Topic === d.spec.Topic) === i,
  );
  const profiles = Object.keys(catalog?.profiles ?? {});

  const q = query.trim().toLowerCase();
  const matches = (name: string, spec: DatasetSpec) =>
    (filter.kind !== "profile" || spec.Config === filter.profile) &&
    (!q || [name, spec.Topic, schemaLabel(spec.AllowedTypes), spec.Config].some((v) => String(v ?? "").toLowerCase().includes(q)));

  const center = () => {
    const box = document.querySelector(".canvas")?.getBoundingClientRect();
    const p = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
    return { x: p.x - 80 + Math.random() * 40, y: p.y - 30 + Math.random() * 40 };
  };

  const showMine = filter.kind !== "others";
  const showOthers = filter.kind !== "pipeline";
  const title = filter.kind === "pipeline" ? "This pipeline" : filter.kind === "others" ? "Other pipelines" : `Profile ${filter.profile}`;

  return (
    <div className="assets-body">
      <div className="tree" data-testid="dataset-tree">
        <div className={`tree-item tree-root${filter.kind === "pipeline" ? " active" : ""}`} onClick={() => setFilter({ kind: "pipeline" })}>
          ▾ This pipeline <span className="muted">({mine.length})</span>
        </div>
        <div
          className={`tree-item tree-root${filter.kind === "others" ? " active" : ""}`}
          onClick={() => setFilter({ kind: "others" })}
          data-testid="other-datasets"
        >
          ▾ Other pipelines <span className="muted">({reusable.length})</span>
        </div>
        <div className="tree-item tree-root muted" title={catalog?.configs ? `${catalog.configs.repo} @ ${catalog.configs.ref}` : undefined}>
          ▾ Profiles (read-only)
        </div>
        {profiles.map((p) => (
          <div
            key={p}
            className={`tree-item depth-1${filter.kind === "profile" && filter.profile === p ? " active" : ""}`}
            onClick={() => setFilter({ kind: "profile", profile: p })}
            title={String(catalog?.profiles[p].Brokers ?? "")}
            data-testid={`profile-tree-${p}`}
          >
            <span className="tree-icon">⛁</span>
            {p}
          </div>
        ))}
        <div className="tree-actions">
          <button className="btn btn-small" onClick={() => setAdding(true)} data-testid="add-dataset">
            + Kafka
          </button>
        </div>
      </div>
      <div className="cards-pane">
        <div className="crumbs">
          {title}
          <span className="crumbs-right">
            <input className="search" placeholder="Search Kafkas" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="dataset-search" />
          </span>
        </div>
        {adding && (
          <NewDataset
            profiles={profiles}
            types={catalog?.types ?? []}
            taken={new Set(mine.map((d) => d.name))}
            defaultProfile={filter.kind === "profile" ? filter.profile : profiles.includes("kafka/prod") ? "kafka/prod" : profiles[0]}
            onCancel={() => setAdding(false)}
            onAdd={(name, spec) => {
              useStudio.getState().addDataset(name, spec, center());
              setAdding(false);
            }}
          />
        )}
        <div className="cards" data-testid="dataset-cards">
          {showMine && mine.filter((d) => matches(d.name, d.spec)).map((d) => <Card key={d.name} {...d} onCanvas draggable={false} />)}
          {showOthers &&
            reusable
              .filter((d) => matches(d.name, d.spec))
              .map((d) => <Card key={`${d.folder}/${d.name}`} name={d.name} spec={d.spec} note={d.folder} onCanvas={false} draggable />)}
          {(showMine ? mine : []).concat(showOthers ? reusable : []).filter((d) => matches(d.name, d.spec)).length === 0 && (
            <div className="empty">No Kafkas here.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewDataset({
  profiles,
  types,
  taken,
  defaultProfile,
  onAdd,
  onCancel,
}: {
  profiles: string[];
  types: string[];
  taken: Set<string>;
  defaultProfile?: string;
  onAdd: (name: string, spec: DatasetSpec) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [profile, setProfile] = useState(defaultProfile ?? "");
  const [allowed, setAllowed] = useState<string[]>([]);
  const error = name && !NAME_RE.test(name)
    ? "invalid name"
    : taken.has(name)
      ? "already in this pipeline"
      : topic && !TOPIC_RE.test(topic)
        ? "not a valid Kafka topic name"
        : null;
  const ready = name && topic && profile && allowed.length && !error;
  return (
    <form
      className="inline-form"
      data-testid="new-dataset"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onAdd(name, { Config: profile, AllowedTypes: allowed, Topic: topic });
      }}
    >
      <span className="note">The topic must already exist; nothing here creates one.</span>
      <input placeholder="name, e.g. ConvertedPackets" value={name} onChange={(e) => setName(e.target.value.trim())} data-testid="new-dataset-name" autoFocus />
      <input placeholder="topic" value={topic} onChange={(e) => setTopic(e.target.value.trim())} data-testid="new-dataset-topic" />
      <select value={profile} onChange={(e) => setProfile(e.target.value)} data-testid="new-dataset-profile">
        {profiles.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <select
        multiple
        value={allowed}
        title="AllowedTypes: the types written here (ctrl-click for several)"
        onChange={(e) => setAllowed([...e.target.selectedOptions].map((o) => o.value))}
        data-testid="new-dataset-types"
      >
        {types.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {error && <span className="issue">{error}</span>}
      <button className="btn btn-small btn-primary" disabled={!ready} data-testid="new-dataset-add">
        Add
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
