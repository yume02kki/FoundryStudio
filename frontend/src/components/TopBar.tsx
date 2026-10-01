import { api, ApiError } from "../api";
import { useStudio, type Theme } from "../store";

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

const THEME_NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

export async function saveDraft() {
  const s = useStudio.getState();
  if (!s.meta?.name || s.busy) return;
  useStudio.setState({ busy: "save" });
  try {
    const graph = s.graph();
    const res = await api.save(graph, s.layout());
    s.markSaved({ kind: "draft", name: graph.name });
    s.toast({ kind: "success", text: `Draft saved to ${res.path}` });
    api.pipelines().then((p) => useStudio.setState({ pipelines: p.pipelines }));
  } catch (e) {
    s.toast({ kind: "error", text: `Save failed: ${(e as Error).message}` }, 9000);
  } finally {
    useStudio.setState({ busy: null });
  }
}

function ValidationStatus() {
  const validation = useStudio((s) => s.validation);
  const validating = useStudio((s) => s.validating);
  const open = useStudio((s) => s.issuesOpen);
  const toggle = () => useStudio.setState({ issuesOpen: !open });

  if (!validation) {
    return <span className="status status-muted">{validating ? "Validating…" : "Not validated"}</span>;
  }
  const n = validation.errors.length;
  return (
    <button
      className={`status ${validation.ok ? "status-success" : "status-danger"}`}
      data-testid="validation-status"
      onClick={toggle}
      aria-expanded={open}
      title={validation.ok ? validation.summary ?? "" : "Show problems"}
    >
      <span className="status-icon">{validation.ok ? "✓" : "!"}</span>
      {validation.ok ? "Valid" : `${n} problem${n === 1 ? "" : "s"}`}
      {validating && <span className="spinner" aria-label="validating" />}
    </button>
  );
}

function MergeRequestStatus() {
  const mr = useStudio((s) => s.mr);
  if (!mr) return null;
  const status = mr.pipeline?.status ?? null;
  const label = status ? CI_LABEL[status] ?? status : "no CI";
  const tone =
    status === "success" ? "success" : status === "failed" ? "danger" : status === "running" || label === "pending" ? "running" : "muted";
  return (
    <a
      className={`status status-${tone}`}
      href={mr.pipeline?.webUrl ?? mr.webUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="mr-chip"
      title={`${mr.title}\n${mr.sourceBranch}`}
    >
      <span className="dot" />!{mr.iid} · {mr.state} · CI {label}
    </a>
  );
}

function LiveStatus() {
  const live = useStudio((s) => s.live);
  const watcher = useStudio((s) => s.watcher);
  const demo = useStudio((s) => s.health?.mode === "demo");
  const errors = Object.entries(watcher?.errors ?? {});
  const title = live
    ? `Watching ${watcher?.projects.join(", ")} (${watcher?.mode}, every ${watcher?.pollInterval}s)` +
      (errors.length ? `\n${errors.map(([p, e]) => `${p}: ${e}`).join("\n")}` : "")
    : "Live updates disconnected; reconnecting…";
  return (
    <span className={`live ${live ? (errors.length ? "live-warn" : "live-on") : "live-off"}`} title={title} data-testid="live-chip">
      <span className="dot" />
      {live ? (errors.length ? "Watch errors" : "Live") : "Offline"}
      {demo && <span className="tag tag-muted">demo</span>}
    </span>
  );
}

export function TopBar({ onOpen, onNew }: { onOpen: (name: string, source?: "draft" | "deployed") => void; onNew: () => void }) {
  const meta = useStudio((s) => s.meta);
  const origin = useStudio((s) => s.origin);
  const dirty = useStudio((s) => s.dirty);
  const pipelines = useStudio((s) => s.pipelines);
  const busy = useStudio((s) => s.busy);
  const theme = useStudio((s) => s.theme);
  const setTheme = useStudio((s) => s.setTheme);

  const value = origin.kind === "new" ? "" : `${origin.kind}:${origin.name}`;
  const originLabel = origin.kind === "new" ? "New" : origin.kind === "draft" ? "Local draft" : "PipelineDeploys";

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ⬡
        </span>
        Foundry Studio
      </div>
      <span className="divider" />
      <select
        className="picker"
        value={value}
        aria-label="Open pipeline"
        data-testid="pipeline-picker"
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") return onNew();
          const [source, name] = v.split(":");
          onOpen(name, source as "draft" | "deployed");
        }}
      >
        {origin.kind === "new" && <option value="">Untitled pipeline</option>}
        {pipelines.some((p) => p.deployed) && (
          <optgroup label="Deployed (PipelineDeploys)">
            {pipelines
              .filter((p) => p.deployed)
              .map((p) => (
                <option key={`d-${p.name}`} value={`deployed:${p.name}`}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        )}
        {pipelines.some((p) => p.draft) && (
          <optgroup label="Local drafts">
            {pipelines
              .filter((p) => p.draft)
              .map((p) => (
                <option key={`l-${p.name}`} value={`draft:${p.name}`}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        )}
        <option value="__new">＋ New pipeline</option>
      </select>
      <div className="title" data-testid="pipeline-title">
        <span className="title-name">{meta?.name || <span className="muted">Untitled</span>}</span>
        <span className="tag tag-muted">{originLabel}</span>
        {dirty && (
          <span className="unsaved" title="Unsaved changes">
            Unsaved
          </span>
        )}
      </div>
      <span className="grow" />
      <LiveStatus />
      <MergeRequestStatus />
      <ValidationStatus />
      <span className="divider" />
      <button
        className="icon-btn theme"
        onClick={() => setTheme(THEME_NEXT[theme])}
        title={`Theme: ${theme} (click to change)`}
        aria-label={`Theme: ${theme}`}
      >
        {THEME_ICON[theme]}
      </button>
      <button className="btn" onClick={saveDraft} disabled={!meta?.name || busy !== null} data-testid="save" title="Save draft (Ctrl/⌘ S)">
        {busy === "save" ? "Saving…" : "Save"}
      </button>
      <button
        className="btn btn-primary"
        onClick={() => useStudio.setState({ deployOpen: true })}
        disabled={!meta?.name || busy !== null}
        data-testid="deploy"
        title="Render with deploy.py and open a merge request on PipelineDeploys"
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
          link: res.mrUrl ? { href: res.mrUrl, label: "View merge request ↗" } : undefined,
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
