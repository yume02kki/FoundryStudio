import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { NAME_RE, useStudio } from "../store";
import type { Issue } from "../types";

export function focusIssue(issue: Issue) {
  const s = useStudio.getState();
  const edges = issue.edge ? [`${issue.edge[0]}->${issue.edge[1]}`] : [];
  const nodes = issue.nodes.length ? issue.nodes : issue.node ? [issue.node] : [];
  s.select({ nodes: issue.edge ? [] : nodes.slice(0, 1), edges });
  s.setFocus({ nodes, edges });
}

function ValidationChip() {
  const validation = useStudio((s) => s.validation);
  const validating = useStudio((s) => s.validating);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!validation) {
    return <div className="chip chip-muted">{validating ? "validating…" : "not validated"}</div>;
  }
  if (validation.ok) {
    return (
      <div className="chip chip-ok" data-testid="validation-status" title={validation.summary ?? ""}>
        ✓ deploy.py: valid{validating ? " …" : ""}
      </div>
    );
  }
  const n = validation.errors.length;
  return (
    <div className="chip-wrap" ref={ref}>
      <button className="chip chip-error" data-testid="validation-status" onClick={() => setOpen(!open)}>
        ✗ {n} error{n === 1 ? "" : "s"}
        {validating ? " …" : ""} ▾
      </button>
      {open && (
        <div className="dropdown errors-list" data-testid="validation-errors">
          <div className="dropdown-title">deploy.py validate</div>
          {validation.errors.map((e) => (
            <button
              key={e.message}
              className="error-item"
              onClick={() => {
                focusIssue(e);
                setOpen(false);
              }}
            >
              {e.message}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Turns Live data on for the whole pipeline: the canvas animates, nodes show live numbers. */
function LiveToggle() {
  const on = useStudio((s) => s.feedsOn);
  return (
    <button
      className={`chip live-toggle${on ? " on" : ""}`}
      onClick={() => useStudio.setState(on ? { feedsOn: false } : { feedsOn: true, bottomTab: "live", liveStage: null })}
      title={on ? "Stop watching the pipeline's topics" : "Watch data flow through the pipeline (read-only)"}
      data-testid="live-toggle"
    >
      <span className="dot" /> {on ? "Live data on" : "Live data"}
    </button>
  );
}

/** The pipeline's deploy state (deploy.py's record); opens the deploy panel. */
function DeployChip() {
  const name = useStudio((s) => s.meta?.name);
  const record = useStudio((s) => s.pipelines.find((p) => p.name === s.meta?.name)?.deploy ?? null);
  if (!name) return null;
  const open = () => useStudio.setState({ deployOpen: true });
  if (!record) {
    return (
      <button className="chip chip-muted" onClick={open} data-testid="deploy-chip" title="Never deployed">
        not deployed
      </button>
    );
  }
  const cls = record.action === "stop" ? "muted" : "ok";
  const label = record.action === "stop" ? "stopped" : record.action === "rollback" ? "rolled back" : "deployed";
  return (
    <button
      className={`chip chip-${cls}`}
      onClick={open}
      data-testid="deploy-chip"
      title={`${record.action} ${record.id} at ${record.at} by ${record.by}`}
    >
      <span className="dot" /> {label} · {record.id}
    </button>
  );
}

/** Save: the catalog (if edited), then the pipeline. Resolves true when everything was saved. */
export async function saveAll(): Promise<boolean> {
  const s = useStudio.getState();
  useStudio.setState({ busy: "save" });
  try {
    if (s.catalogDirty && s.catalog) {
      const res = await api.saveCatalog(s.catalog);
      useStudio.setState({ catalog: res.catalog, catalogDirty: false });
    }
    const graph = s.graph();
    const res = await api.save(graph, s.layout());
    s.markSaved({ kind: "saved", name: graph.name });
    s.toast({ kind: "success", text: `Saved ${res.path}`, testId: "saved" });
    const p = await api.pipelines();
    useStudio.setState({ pipelines: p.pipelines });
    return true;
  } catch (e) {
    const err = e as ApiError;
    s.toast({ kind: "error", text: `Save failed: ${err.message}${err.errors?.length ? ` — ${err.errors[0].message}` : ""}` }, 9000);
    return false;
  } finally {
    useStudio.setState({ busy: null });
  }
}

export function TopBar({ onOpen, onNew }: { onOpen: (name: string) => void; onNew: () => void }) {
  const meta = useStudio((s) => s.meta);
  const origin = useStudio((s) => s.origin);
  const dirty = useStudio((s) => s.dirty);
  const pipelines = useStudio((s) => s.pipelines);
  const busy = useStudio((s) => s.busy);
  const health = useStudio((s) => s.health);
  const watcher = useStudio((s) => s.watcher);
  const live = useStudio((s) => s.live);
  const catalogDirty = useStudio((s) => s.catalogDirty);

  const value = origin.kind === "new" ? "" : origin.name;
  const watchErrors = Object.keys(watcher?.errors ?? {}).length;

  return (
    <header className="topbar">
      <div className="brand">◆ Foundry Studio</div>
      <select
        className="picker"
        value={value}
        data-testid="pipeline-picker"
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") return onNew();
          onOpen(v);
        }}
      >
        {origin.kind === "new" && <option value="">New pipeline</option>}
        {pipelines.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
        <option value="__new">+ New pipeline…</option>
      </select>
      <div className="pipeline-name" data-testid="pipeline-title">
        <input
          className={`name-input${meta?.name && !NAME_RE.test(meta.name) ? " invalid" : ""}`}
          value={meta?.name ?? ""}
          placeholder="Name this pipeline"
          size={Math.max(12, (meta?.name ?? "").length + 1)}
          spellCheck={false}
          title="Pipeline name (the manifest's Name). Click to edit."
          onChange={(e) => useStudio.getState().updateMeta((m) => ({ ...m, name: e.target.value.trim() }))}
          data-testid="pipeline-name"
        />
        {(dirty || catalogDirty) && (
          <span className="dirty" title={catalogDirty ? "Unsaved changes (including the catalog)" : "Unsaved changes"} data-testid="dirty">
            {" "}●
          </span>
        )}
      </div>
      <ValidationChip />
      <span className="spacer" />
      <div
        className={`chip chip-${live ? (watchErrors ? "warn" : "muted") : "error"}`}
        title={
          live
            ? `Watching ${watcher?.scope === "fixed" ? watcher.projects.join(", ") : `every project you're a member of (${watcher?.projects.length ?? 0})`}; transformers in ${(watcher?.withTransformers ?? []).join(", ") || "none yet"} (${watcher?.mode}, every ${watcher?.pollInterval}s)` +
              (watchErrors ? `\n${Object.entries(watcher!.errors).map(([p, e]) => `${p}: ${e}`).join("\n")}` : "")
            : "Live updates disconnected"
        }
        data-testid="live-chip"
      >
        <span className={`dot ${live ? "dot-live" : ""}`} /> {live ? watcher?.mode ?? "live" : "offline"}
        {health?.mode === "demo" ? " · demo" : ""}
      </div>
      <LiveToggle />
      <DeployChip />
      <button className="btn" onClick={() => void saveAll()} disabled={!meta?.name || busy !== null} data-testid="save">
        {busy === "save" ? "Saving…" : "Save"}
      </button>
      <button
        className="btn btn-primary"
        onClick={() => useStudio.setState({ deployOpen: true })}
        disabled={!meta?.name || busy !== null}
        data-testid="deploy"
      >
        {busy === "deploy" ? "Deploying…" : "Deploy"}
      </button>
    </header>
  );
}
