import { useEffect, useMemo, useState, type DragEvent } from "react";
import { schemaColor } from "../lib/schemaColor";
import { useStudio } from "../store";
import type { TransformerInfo } from "../types";
import { DRAG_MIME } from "./Canvas";
import { LiveData, LiveTabBadges } from "./LiveData";

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

interface Folder {
  key: string; // "<project>:<path>"
  project: string;
  path: string;
  label: string;
  depth: number;
}

function folders(projects: string[], transformers: TransformerInfo[]): Folder[] {
  const out: Folder[] = [];
  for (const project of projects) {
    out.push({ key: `${project}:`, project, path: "", label: project, depth: 0 });
    const paths = new Set<string>();
    for (const t of transformers.filter((t) => t.project === project)) {
      const parts = t.path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
    }
    for (const path of [...paths].sort()) {
      const parts = path.split("/");
      out.push({ key: `${project}:${path}`, project, path, label: parts[parts.length - 1], depth: parts.length });
    }
  }
  return out;
}

function SchemaChip({ schema }: { schema: string | null }) {
  return (
    <span className="schema-chip" style={{ borderColor: schemaColor(schema), color: schemaColor(schema) }}>
      {schema ?? "?"}
    </span>
  );
}

function Card({ t, favorite, onFavorite }: { t: TransformerInfo; favorite: boolean; onFavorite: () => void }) {
  const changed = useStudio((s) => s.changed[t.id]);
  const [ref, setRef] = useState(t.latest);
  useEffect(() => setRef(t.latest), [t.latest]);
  const version = t.versions.find((v) => v.ref === ref) ?? t.versions[0];
  const fresh = changed && Date.now() - changed.at < 15000;

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: t.id, ref: version.ref }));
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
        <SchemaChip schema={version.input} /> <span className="arrow">→</span> <SchemaChip schema={version.output} />
      </div>
      <div className="card-foot">
        <select
          value={version.ref}
          onChange={(e) => setRef(e.target.value)}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          data-testid={`card-version-${t.name}`}
        >
          {t.versions.map((v) => (
            <option key={v.ref} value={v.ref}>
              {v.label}
              {v.ref === t.latest ? " (latest)" : ""}
            </option>
          ))}
        </select>
        {t.inferred && (
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
  const transformers = useStudio((s) => s.transformers);
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

  const list = useMemo(() => Object.values(transformers).sort((a, b) => a.name.localeCompare(b.name)), [transformers]);
  const projects = health?.transformerProjects ?? [...new Set(list.map((t) => t.project))];
  const tree = useMemo(() => folders(projects, list), [projects, list]);

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
    selected === FAVORITES ? ["Favorites"] : selected ? selected.replace(":", "/").split("/").filter(Boolean) : ["All transformers"];
  const errors = Object.entries(watcher?.errors ?? {});

  return (
    <div className="assets">
      <div className="panel-tabs" role="tablist">
        <button
          role="tab"
          className={`tab${tab === "project" ? " active" : ""}`}
          onClick={() => useStudio.setState({ bottomTab: "project" })}
          data-testid="tab-project"
        >
          Project
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
        {tab === "project" ? (
          <input
            className="search"
            placeholder="Search transformers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="asset-search"
          />
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
      ) : (
      <div className="assets-body">
        <div className="tree" data-testid="asset-tree">
          <div className={`tree-item${selected === FAVORITES ? " active" : ""}`} onClick={() => setSelected(FAVORITES)}>
            <span className="fav">★</span> Favorites
          </div>
          {favorites
            .map((id) => transformers[id])
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
            ▾ Git paths
          </div>
          {tree.map((f) => (
            <div
              key={f.key}
              className={`tree-item depth-${Math.min(f.depth + 1, 4)}${selected === f.key ? " active" : ""}`}
              onClick={() => setSelected(f.key)}
              title={`${f.project}/${f.path}`}
              data-testid={`tree-${f.project}/${f.path}`}
            >
              {f.depth === 0 ? "◆ " : "▸ 📁 "}
              {f.label}
            </div>
          ))}
        </div>
        <div className="cards-pane">
          <div className="crumbs">
            {crumbs.join(" › ")}
            <span className="crumbs-right">
              {shown.length} transformer{shown.length === 1 ? "" : "s"} · drag onto the canvas
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
            {shown.length === 0 && <div className="empty">No transformers here.</div>}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
