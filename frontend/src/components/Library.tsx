import { useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { schemaColor } from "../lib/schemaColor";
import { useStudio } from "../store";
import type { TransformerInfo } from "../types";
import { DRAG_MIME } from "./Canvas";

const FAV_KEY = "foundry-studio.favorites";

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
    /* favourites last for this session only */
  }
}

export function SchemaPill({ schema }: { schema: string | null | undefined }) {
  const color = schemaColor(schema);
  return (
    <span className="schema-pill" style={{ ["--schema" as string]: color }}>
      <span className="schema-dot" />
      {schema ?? "untyped"}
    </span>
  );
}

function Item({
  t,
  favorite,
  onFavorite,
  onAdd,
}: {
  t: TransformerInfo;
  favorite: boolean;
  onFavorite: () => void;
  onAdd: (ref: string) => void;
}) {
  const changed = useStudio((s) => s.changed[t.id]);
  const [ref, setRef] = useState(t.latest);
  useEffect(() => setRef(t.latest), [t.latest]);
  const version = t.versions.find((v) => v.ref === ref) ?? t.versions[0];
  const fresh = changed && Date.now() - changed.at < 20000;

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: t.id, ref: version.ref }));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      className={`lib-item${fresh ? ` lib-item-${changed.kind}` : ""}`}
      draggable
      onDragStart={onDragStart}
      data-testid={`card-${t.name}`}
      title={[t.description, `${t.project} / ${t.path}`].filter(Boolean).join("\n")}
    >
      <div className="lib-item-head">
        <span className="lib-item-name">{t.name}</span>
        <span className="grow" />
        <button
          className={`icon-btn star${favorite ? " on" : ""}`}
          onClick={onFavorite}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
        >
          {favorite ? "★" : "☆"}
        </button>
        <button className="icon-btn add" onClick={() => onAdd(version.ref)} aria-label={`Add ${t.name} to the canvas`} title="Add to canvas">
          +
        </button>
      </div>
      {t.description && <div className="lib-item-desc">{t.description}</div>}
      <div className="lib-item-types">
        <SchemaPill schema={version.input} />
        <span className="arrow">→</span>
        <SchemaPill schema={version.output} />
        <span className="lib-item-tags">
          {fresh && <span className={`tag tag-${changed.kind}`}>{changed.kind === "added" ? "New" : "Updated"}</span>}
          {t.inferred && (
            <span className="tag tag-warning" title={t.warnings.join("\n")}>
              Inferred
            </span>
          )}
        </span>
      </div>
      <select
        className="lib-item-version"
        value={version.ref}
        onChange={(e) => setRef(e.target.value)}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        aria-label={`${t.name} version`}
        data-testid={`card-version-${t.name}`}
      >
        {t.versions.map((v) => (
          <option key={v.ref} value={v.ref}>
            {v.label}
            {v.ref === t.latest ? " · latest" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Library() {
  const transformers = useStudio((s) => s.transformers);
  const watcher = useStudio((s) => s.watcher);
  const hasPipeline = useStudio((s) => s.meta !== null);
  const flow = useReactFlow();
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [, tick] = useState(0);

  // Re-render so the New/Updated tags fade out.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const list = useMemo(
    () => Object.values(transformers).sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path)),
    [transformers],
  );
  const q = query.trim().toLowerCase();
  const matches = (t: TransformerInfo) =>
    !q || [t.name, t.path, t.description, t.input, t.output].some((v) => v?.toLowerCase().includes(q));

  const groups: { key: string; title: string; items: TransformerInfo[] }[] = [];
  const favs = list.filter((t) => favorites.includes(t.id) && matches(t));
  if (favs.length) groups.push({ key: "★", title: "Favorites", items: favs });
  for (const t of list.filter(matches)) {
    const folder = t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : "";
    const key = `${t.project}/${folder}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, title: folder ? `${t.project} / ${folder}` : t.project, items: [] }));
    g.items.push(t);
  }

  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    setFavorites(next);
    saveFavorites(next);
  };

  const addToCanvas = (info: TransformerInfo, ref: string) => {
    const s = useStudio.getState();
    if (!s.meta) return;
    const rect = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
    const p = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    // Nudge so repeated adds don't stack exactly.
    const n = s.nodes.length;
    s.addTransformer(info, ref, { x: p.x - 110 + (n % 4) * 24, y: p.y + 80 + (n % 4) * 24 });
  };

  const errors = Object.entries(watcher?.errors ?? {});

  return (
    <aside className="library" aria-label="Transformer library">
      <div className="panel-head">
        <span className="panel-title">Transformers</span>
        <span className="count">{list.length}</span>
      </div>
      <div className="library-search">
        <input
          type="search"
          placeholder="Search by name or schema"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="asset-search"
        />
      </div>
      {errors.length > 0 && (
        <div className="callout callout-danger">
          {errors.map(([p, e]) => (
            <div key={p}>
              <b>{p}</b>: {e}
            </div>
          ))}
        </div>
      )}
      <div className="library-list" data-testid="cards">
        {groups.map((g) => (
          <section key={g.key} className="lib-group">
            <button className="lib-group-head" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
              <span className={`chevron${collapsed[g.key] ? "" : " open"}`}>›</span>
              {g.title}
              <span className="count">{g.items.length}</span>
            </button>
            {!collapsed[g.key] &&
              g.items.map((t) => (
                <Item
                  key={`${g.key}:${t.id}`}
                  t={t}
                  favorite={favorites.includes(t.id)}
                  onFavorite={() => toggleFavorite(t.id)}
                  onAdd={(ref) => addToCanvas(t, ref)}
                />
              ))}
          </section>
        ))}
        {list.length === 0 && <div className="empty">{watcher?.ready ? "No transformers found." : "Discovering transformers…"}</div>}
        {list.length > 0 && groups.length === 0 && <div className="empty">Nothing matches “{query}”.</div>}
      </div>
      <div className="library-foot">{hasPipeline ? "Drag onto the canvas, or press +" : ""}</div>
    </aside>
  );
}
