import { useEffect, useMemo, useState, type DragEvent } from "react";
import { schemaColor } from "../lib/schemaColor";
import { useStudio } from "../store";
import type { ProcessorInfo } from "../types";
import { DRAG_MIME } from "./Canvas";
import { Datasets } from "./Datasets";
import { LiveData, LiveTabBadges } from "./LiveData";
import { ANY, schemaList } from "../lib/rules";

const FAV_KEY = "foundry-studio.favorites";
const FAVORITES = "★favorites";

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveFavorites(ids: string[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: favourites last for this session only */
  }
}

interface TreeEntry {
  key: string; // "<project>:<path>", the filter the entry selects
  project: string;
  path: string;
  label: string;
  depth: number;
  kind: "repo" | "folder" | "processor";
  title: string;
}

/**
 * The tree shows processors, not raw git directories: a repo, the folders that only
 * group processors, and each processor (a crate directory) under its own name.
 * A repo that is a single processor is just that processor.
 */
function processorEntry(project: string, path: string, depth: number, t: ProcessorInfo): TreeEntry {
  return { key: `${project}:${path}`, project, path, label: t.name, depth, kind: "processor",
           title: `${t.input ?? "?"} → ${t.output ?? "?"}${t.description ? `\n${t.description}` : ""}` };
}

function treeEntries(projects: string[], processors: ProcessorInfo[]): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const project of projects) {
    const mine = processors.filter((t) => t.project === project);
    if (mine.length === 1 && !mine[0].path) {
      out.push(processorEntry(project, "", 0, mine[0]));
      continue;
    }
    out.push({ key: `${project}:`, project, path: "", label: project.split("/").pop() ?? project, depth: 0, kind: "repo", title: project });
    const crates = new Map(mine.map((t) => [t.path, t]));
    const groups = new Set<string>();
    for (const t of mine) {
      const parts = t.path.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) groups.add(parts.slice(0, i).join("/"));
    }
    const paths = [...new Set([...groups, ...crates.keys()])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    for (const path of paths) {
      const t = crates.get(path);
      const depth = path ? path.split("/").length : 1;
      out.push(
        t
          ? processorEntry(project, path, depth, t)
          :{ key: `${project}:${path}`, project, path, label: path.split("/").pop()!, depth, kind: "folder", title: path },
      );
    }
  }
  return out;
}

function SchemaChip({ schema }: { schema: string | null }) {
  return (
    <span className="schema-chip" style={{ borderColor: schemaColor(schema), color: schemaColor(schema) }}>
      {schema || ANY}
    </span>
  );
}

function Card({ t, favorite, onFavorite }: { t: ProcessorInfo; favorite: boolean; onFavorite: () => void }) {
  const changed = useStudio((s) => s.changed[t.id]);
  // Cards add the processor without a Ref (its default branch); pin a version on the node.
  const version = t.versions.find((v) => v.kind === "branch") ?? t.versions[0];
  const fresh = changed && Date.now() - changed.at < 15000;

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: t.id, ref: "" })); // no Ref: default branch
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      className={`card${fresh ? ` card-${changed.kind}` : ""}`}
      draggable
      onDragStart={onDragStart}
      data-testid={`card-${t.name}`}
      title={[t.description, `${t.project}/${t.path}`, ...t.warnings].filter(Boolean).join("\n")}
    >
      <div className="card-head">
        <span className="card-icon">⚙</span>
        <span className="card-name">{t.name}</span>
        <button className={`star${favorite ? " on" : ""}`} onClick={onFavorite} title="Favorite">
          {favorite ? "★" : "☆"}
        </button>
      </div>
      <div className="card-types">
        {/* One line per input schema (a processor reading several), then what it writes. */}
        <span className="card-inputs">
          {(schemaList(version.input) ?? [version.input]).map((s, i) => (
            <SchemaChip key={i} schema={s} />
          ))}
        </span>
        <span className="arrow">→</span> <SchemaChip schema={version.output} />
      </div>
      <div className="card-foot">
        {t.warnings.length > 0 && (
          <span className="badge badge-warn" title={t.warnings.join("\n")}>
            ⚠
          </span>
        )}
        {fresh && <span className={`badge badge-${changed.kind}`}>{changed.kind === "added" ? "new" : "updated"}</span>}
      </div>
    </div>
  );
}

export function AssetBrowser() {
  const processors = useStudio((s) => s.processors);
  const health = useStudio((s) => s.health);
  const watcher = useStudio((s) => s.watcher);
  const tab = useStudio((s) => s.bottomTab);
  const feedsOn = useStudio((s) => s.feedsOn);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const [, tick] = useState(0);

  // Re-render so "new"/"updated" highlights fade out.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const list = useMemo(() => Object.values(processors).sort((a, b) => a.name.localeCompare(b.name)), [processors]);
  const projects = health?.processorProjects ?? [...new Set(list.map((t) => t.project))];
  const tree = useMemo(() => treeEntries(projects, list), [projects, list]);

  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    setFavorites(next);
    saveFavorites(next);
  };

  const q = query.trim().toLowerCase();
  const shown = list.filter((t) => {
    if (selected === FAVORITES && !favorites.includes(t.id)) return false;
    if (selected && selected !== FAVORITES) {
      const [project, path] = [selected.slice(0, selected.indexOf(":")), selected.slice(selected.indexOf(":") + 1)];
      if (t.project !== project) return false;
      if (path && t.path !== path && !t.path.startsWith(`${path}/`)) return false;
    }
    if (!q) return true;
    return [t.name, t.path, t.description, t.input, t.output].some((v) => v?.toLowerCase().includes(q));
  });
  const crumbs =
    selected === FAVORITES ? ["Favorites"] : selected ? selected.replace(":", "/").split("/").filter(Boolean) : ["All processors"];
  const errors = Object.entries(watcher?.errors ?? {});

  return (
    <div className="assets">
      <div className="panel-tabs" role="tablist">
        <button
          role="tab"
          className={`tab${tab === "processors" ? " active" : ""}`}
          onClick={() => useStudio.setState({ bottomTab: "processors" })}
          data-testid="tab-processors"
        >
          Processors
        </button>
        <button
          role="tab"
          className={`tab${tab === "datasets" ? " active" : ""}`}
          onClick={() => useStudio.setState({ bottomTab: "datasets" })}
          data-testid="tab-datasets"
        >
          Datasets
        </button>
        <button
          role="tab"
          className={`tab${tab === "live" ? " active" : ""}`}
          onClick={() => useStudio.setState({ bottomTab: "live" })}
          data-testid="tab-live"
        >
          Live data <LiveTabBadges />
        </button>
        <span className="tab-spacer" />
        {tab === "processors" ? (
          <input
            className="search"
            placeholder="Search processors"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="asset-search"
          />
        ) : tab === "datasets" ? (
          <span className="tab-note">This pipeline's datasets · drag in another pipeline's to reuse its topic</span>
        ) : (
          <>
            <span className="tab-note">Read-only: never joins the pipeline's consumer group, never commits offsets</span>
            {feedsOn && (
              <button className="btn btn-small" onClick={() => useStudio.setState({ feedsOn: false })} data-testid="feeds-stop">
                Stop
              </button>
            )}
          </>
        )}
      </div>
      {tab === "live" ? (
        <LiveData />
      ) : tab === "datasets" ? (
        <Datasets />
      ) : (
      <div className="assets-body">
        <div className="tree" data-testid="asset-tree">
          <div className={`tree-item${selected === FAVORITES ? " active" : ""}`} onClick={() => setSelected(FAVORITES)}>
            <span className="fav">★</span> Favorites
          </div>
          {favorites
            .map((id) => processors[id])
            .filter(Boolean)
            .map((t) => (
              <div key={t.id} className="tree-item depth-1 muted" onClick={() => setSelected(`${t.project}:${t.path}`)}>
                ⚙ {t.name}
              </div>
            ))}
          <div
            className={`tree-item tree-root${selected === null ? " active" : ""}`}
            onClick={() => setSelected(null)}
          >
            ▾ Processors
          </div>
          {tree.map((f) => (
            <div
              key={f.key}
              className={`tree-item tree-${f.kind} depth-${Math.min(f.depth + 1, 4)}${selected === f.key ? " active" : ""}`}
              onClick={() => setSelected(f.key)}
              title={f.title}
              data-testid={`tree-${f.project}/${f.path}`}
            >
              <span className="tree-icon">{f.kind === "processor" ? "⚙" : "📁"}</span>
              {f.label}
            </div>
          ))}
        </div>
        <div className="cards-pane">
          <div className="crumbs">
            {crumbs.join(" › ")}
            <span className="crumbs-right">
              {shown.length} processor{shown.length === 1 ? "" : "s"} · drag onto the canvas
            </span>
          </div>
          {errors.length > 0 && (
            <div className="watch-error">
              {errors.map(([p, e]) => (
                <div key={p}>
                  {p}: {e}
                </div>
              ))}
            </div>
          )}
          <div className="cards" data-testid="cards">
            {shown.map((t) => (
              <Card key={t.id} t={t} favorite={favorites.includes(t.id)} onFavorite={() => toggleFavorite(t.id)} />
            ))}
            {shown.length === 0 && <div className="empty">No processors here.</div>}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
