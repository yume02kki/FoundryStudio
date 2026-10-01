import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { NAME_RE, useStudio } from "../store";
import type { Issue } from "../types";

const CI_LABEL: Record<string, string> = {
  created: "pending",
  waiting_for_resource: "pending",
  preparing: "pending",
  pending: "pending",
  running: "running",
  success: "passed",
  failed: "failed",
  canceled: "canceled",
  skipped: "skipped",
  manual: "manual",
  scheduled: "scheduled",
};

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

function MrChip() {
  const mr = useStudio((s) => s.mr);
  if (!mr) return <div className="chip chip-muted">no merge requests</div>;
  const status = mr.pipeline?.status ?? null;
  const label = status ? CI_LABEL[status] ?? status : "no CI";
  const cls = status === "success" ? "ok" : status === "failed" ? "error" : status === "running" || status === "pending" ? "running" : "muted";
  return (
    <a className={`chip chip-${cls}`} href={mr.pipeline?.webUrl ?? mr.webUrl} target="_blank" rel="noreferrer" data-testid="mr-chip" title={mr.title}>
      <span className="dot" /> !{mr.iid} · {mr.state} · CI {label}
    </a>
  );
}

export function TopBar({ onOpen, onNew }: { onOpen: (name: string, source?: "draft" | "deployed") => void; onNew: () => void }) {
  const meta = useStudio((s) => s.meta);
  const origin = useStudio((s) => s.origin);
  const dirty = useStudio((s) => s.dirty);
  const pipelines = useStudio((s) => s.pipelines);
  const busy = useStudio((s) => s.busy);
  const health = useStudio((s) => s.health);
  const watcher = useStudio((s) => s.watcher);
  const live = useStudio((s) => s.live);

  const save = async () => {
    const s = useStudio.getState();
    useStudio.setState({ busy: "save" });
    try {
      const graph = s.graph();
      const res = await api.save(graph, s.layout());
      s.markSaved({ kind: "draft", name: graph.name });
      s.toast({ kind: "success", text: `Saved ${res.path}` });
      api.pipelines().then((p) => useStudio.setState({ pipelines: p.pipelines }));
    } catch (e) {
      s.toast({ kind: "error", text: `Save failed: ${(e as Error).message}` }, 9000);
    } finally {
      useStudio.setState({ busy: null });
    }
  };

  const value = origin.kind === "new" ? "" : `${origin.kind}:${origin.name}`;
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
          const [source, name] = v.split(":");
          onOpen(name, source as "draft" | "deployed");
        }}
      >
        {origin.kind === "new" && <option value="">New pipeline</option>}
        {pipelines.map((p) => [
          p.deployed && (
            <option key={`d-${p.name}`} value={`deployed:${p.name}`}>
              {p.name} (PipelineDeploys)
            </option>
          ),
          p.draft && (
            <option key={`l-${p.name}`} value={`draft:${p.name}`}>
              {p.name} (local draft)
            </option>
          ),
        ])}
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
        {dirty && <span className="dirty" title="Unsaved changes"> ●</span>}
      </div>
      <ValidationChip />
      <span className="spacer" />
      <div
        className={`chip chip-${live ? (watchErrors ? "warn" : "muted") : "error"}`}
        title={
          live
            ? `Watching ${watcher?.projects.join(", ")} (${watcher?.mode}, every ${watcher?.pollInterval}s)` +
              (watchErrors ? `\n${Object.entries(watcher!.errors).map(([p, e]) => `${p}: ${e}`).join("\n")}` : "")
            : "Live updates disconnected"
        }
        data-testid="live-chip"
      >
        <span className={`dot ${live ? "dot-live" : ""}`} /> {live ? watcher?.mode ?? "live" : "offline"}
        {health?.mode === "demo" ? " · demo" : ""}
      </div>
      <MrChip />
      <button className="btn" onClick={save} disabled={!meta?.name || busy !== null} data-testid="save">
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

export async function runDeploy() {
  const s = useStudio.getState();
  useStudio.setState({ busy: "deploy", deployOpen: false });
  try {
    const res = await api.deploy(s.graph());
    if (res.status === "up_to_date") {
      s.toast(
        { kind: "info", text: `${s.meta?.name}: already up to date in PipelineDeploys; nothing to deploy.`, testId: "deploy-result" },
        9000,
      );
    } else {
      s.toast(
        {
          kind: "success",
          text: `Merge request opened from ${res.branch ?? "a deploy branch"}`,
          link: res.mrUrl ? { href: res.mrUrl, label: res.mrUrl } : undefined,
          testId: "deploy-result",
        },
        15000,
      );
    }
  } catch (e) {
    const err = e as ApiError;
    s.toast(
      {
        kind: "error",
        text: `Deploy failed: ${err.message}${err.errors?.length ? ` — ${err.errors[0].message}` : ""}`,
        testId: "deploy-result",
      },
      12000,
    );
  } finally {
    useStudio.setState({ busy: null });
  }
}
