import { useEffect, useRef } from "react";
import { api, ApiError, operate } from "../api";
import { schemaColor } from "../lib/schemaColor";
import { findInfo, versionFor } from "../lib/versions";
import { useStudio, type DeployRun } from "../store";
import { saveAll } from "./TopBar";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          {title}
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function VersionPicker() {
  const nodeId = useStudio((s) => s.versionPickerFor);
  const node = useStudio((s) => s.nodes.find((n) => n.id === s.versionPickerFor));
  const transformers = useStudio((s) => s.transformers);
  const updateSpec = useStudio((s) => s.updateSpec);
  if (!nodeId || !node) return null;
  const spec = node.data.spec.transformer;
  const info = findInfo(spec, Object.values(transformers));
  const current = versionFor(info, spec?.Ref);
  const close = () => useStudio.setState({ versionPickerFor: null });

  return (
    <Modal title={`${nodeId} — pick a version`} onClose={close}>
      <div className="versions" data-testid="version-picker">
        <button
          className={`version${!spec?.Ref ? " current" : ""}`}
          onClick={() => {
            const head = info?.versions.find((v) => v.kind === "branch");
            updateSpec(nodeId, (n) => {
              const { Ref: _old, ...rest } = n.transformer ?? {};
              return { ...n, transformer: { ...rest, IN: head?.input ?? rest.IN, OUT: head?.output ?? rest.OUT } };
            });
            close();
          }}
        >
          <span className="version-label">Default branch</span>
          <span className="version-types muted">no Ref: always the latest commit, pinned in the lock file at deploy</span>
          {!spec?.Ref && <span className="badge badge-muted">current</span>}
        </button>
        {info?.versions.map((v) => (
          <button
            key={v.ref}
            className={`version${spec?.Ref && v.ref === current?.ref ? " current" : ""}`}
            onClick={() => {
              updateSpec(nodeId, (n) => ({
                ...n,
                transformer: { ...n.transformer, Ref: v.ref, IN: v.input ?? n.transformer?.IN, OUT: v.output ?? n.transformer?.OUT },
              }));
              close();
            }}
          >
            <span className="version-label">{v.label}</span>
            <span className="version-types">
              <span style={{ color: schemaColor(v.input) }}>{v.input ?? "?"}</span> →{" "}
              <span style={{ color: schemaColor(v.output) }}>{v.output ?? "?"}</span>
            </span>
            <span className="muted">
              {v.commit.slice(0, 8)} · {v.committed_date?.slice(0, 10) ?? ""}
            </span>
            {v.warnings.length > 0 && (
              <span className="badge badge-warn" title={v.warnings.join("\n")}>
                ⚠
              </span>
            )}
            {spec?.Ref && v.ref === current?.ref && <span className="badge badge-muted">current</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

async function refreshDeploys(name: string) {
  try {
    const [history, pipelines] = await Promise.all([api.deploys(name), api.pipelines()]);
    useStudio.setState({ history, pipelines: pipelines.pipelines });
  } catch (e) {
    useStudio.setState({ history: null });
    if (!(e instanceof ApiError && e.status === 400)) throw e;
  }
}

/** Run deploy / rollback / stop through deploy.py, streaming its log into the deploy panel. */
export async function runOperation(op: "deploy" | "rollback" | "stop", id?: string) {
  const s = useStudio.getState();
  const name = s.meta?.name;
  if (!name) return;
  if (op === "deploy" && (s.dirty || s.catalogDirty || s.origin.kind === "new")) {
    if (!(await saveAll())) return;
  }
  useStudio.setState({ busy: "deploy", deployRun: { op, running: true, log: [], outcome: null } });
  const log = (line: string) =>
    useStudio.setState((st) => (st.deployRun ? { deployRun: { ...st.deployRun, log: [...st.deployRun.log, line] } } : st));
  let outcome: NonNullable<DeployRun["outcome"]>;
  try {
    const res = await operate(name, op, log, id ? { id } : undefined);
    if (res.type === "error") {
      outcome = { ok: false, text: res.message, errors: res.errors };
    } else {
      const text = {
        deployed: `Deployed ${name} as ${res.id}`,
        unchanged: `${name} is unchanged since deploy ${res.id}; its containers were (re)started`,
        "rolled-back": `Rolled ${name} back to ${res.from} (recorded as ${res.id})`,
        stopped: `Stopped ${name}`,
      }[res.status];
      outcome = { ok: true, text };
    }
  } catch (e) {
    const err = e as ApiError;
    outcome = { ok: false, text: err.message, errors: err.errors };
  }
  useStudio.setState((st) => ({ busy: null, deployRun: st.deployRun ? { ...st.deployRun, running: false, outcome } : null }));
  useStudio.getState().toast(
    { kind: outcome.ok ? "success" : "error", text: outcome.ok ? outcome.text : `${op} failed: ${outcome.text}`, testId: "deploy-result" },
    outcome.ok ? 8000 : 12000,
  );
  await refreshDeploys(name).catch(() => undefined);
}

function DeployLog() {
  const run = useStudio((s) => s.deployRun);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [run?.log.length]);
  if (!run) return null;
  return (
    <div className="deploy-run" data-testid="deploy-run">
      <div className="deploy-run-title">
        {run.op} {run.running ? "running…" : ""}
      </div>
      <pre className="deploy-log" ref={ref} data-testid="deploy-log">
        {run.log.join("\n")}
      </pre>
      {run.outcome && (
        <div className={`deploy-outcome ${run.outcome.ok ? "ok" : "bad"}`} data-testid="deploy-outcome">
          {run.outcome.ok ? "✓ " : "✗ "}
          {run.outcome.text}
          {run.outcome.errors?.map((e) => (
            <div key={e.message} className="issue">
              {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function History() {
  const history = useStudio((s) => s.history);
  const busy = useStudio((s) => s.busy);
  if (!history) return null;
  const current = history.current;
  return (
    <div className="deploy-history" data-testid="deploy-history">
      <h4>
        History <span className="muted">· {history.project} · runner {history.runner}</span>
      </h4>
      {history.services.length > 0 && (
        <div className="services" data-testid="deploy-services">
          {history.services.map((svc) => (
            <span key={svc.service} className={`tag ${svc.state === "running" ? "tag-ok" : "tag-warning"}`} title={svc.image}>
              {svc.service}: {svc.status}
            </span>
          ))}
        </div>
      )}
      {history.servicesError && <div className="note">Containers: {history.servicesError}</div>}
      {history.history.length === 0 ? (
        <p className="note">Never deployed.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Deploy</th>
              <th>Action</th>
              <th>When</th>
              <th>By</th>
              <th>Transformers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.history.map((h) => (
              <tr key={h.id} className={current?.id === h.id ? "current" : ""} data-testid={`history-${h.id}`}>
                <td className="mono">{h.id}</td>
                <td>
                  {h.action}
                  {h.from ? ` of ${h.from}` : ""}
                  {current?.id === h.id ? (current.action === "stop" ? " · stopped" : " · current") : ""}
                </td>
                <td className="muted">{h.at}</td>
                <td className="muted">{h.by}</td>
                <td className="mono muted">
                  {Object.entries(h.transformers ?? {})
                    .map(([t, v]) => `${t}@${v.commit.slice(0, 7)}`)
                    .join(", ")}
                </td>
                <td>
                  {(current?.id !== h.id || current.action === "stop") && (
                    <button
                      className="btn btn-small"
                      disabled={busy !== null}
                      onClick={() => window.confirm(`Run deploy ${h.id} again, exactly as recorded?`) && void runOperation("rollback", h.id)}
                      data-testid={`rollback-${h.id}`}
                    >
                      Roll back
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DeployDialog() {
  const open = useStudio((s) => s.deployOpen);
  const validation = useStudio((s) => s.validation);
  const name = useStudio((s) => s.meta?.name);
  const health = useStudio((s) => s.health);
  const dirty = useStudio((s) => s.dirty || s.catalogDirty || s.origin.kind === "new");
  const busy = useStudio((s) => s.busy);
  const current = useStudio((s) => s.history?.current);
  useEffect(() => {
    if (open && name) void refreshDeploys(name).catch(() => undefined);
  }, [open, name]);
  if (!open) return null;
  const close = () => useStudio.setState({ deployOpen: false });
  const target = health?.deployTarget;
  return (
    <Modal title={`Deploy ${name}`} onClose={close}>
      <p>
        Runs <code>deploy.py deploy</code> on the saved manifest: checks every dataset's topic exists on its cluster (topics
        are never created), builds each transformer's image at its pinned commit, and starts one container per
        transformer. Every deploy is recorded, so any of them can be run again.
      </p>
      {target ? (
        <p className="note">
          Target: <code>{target}</code>
        </p>
      ) : (
        <div className="issue">Deploying needs a target: set STUDIO_DEPLOY_TARGET to a foundry target.yaml.</div>
      )}
      {dirty && <p className="note">Unsaved changes (pipeline or catalog) are saved first.</p>}
      {validation && !validation.ok && (
        <div className="issue">deploy.py reports {validation.errors.length} error(s); the deploy will be refused.</div>
      )}
      <pre className="manifest-preview">{validation?.manifest ?? ""}</pre>
      <DeployLog />
      <History />
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Close
        </button>
        <span className="spacer" />
        {current && current.action !== "stop" && (
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => window.confirm(`Stop every container of ${name}?`) && void runOperation("stop")}
            data-testid="deploy-stop"
          >
            Stop
          </button>
        )}
        <button className="btn btn-primary" disabled={busy !== null || !target} onClick={() => void runOperation("deploy")} data-testid="deploy-confirm">
          {busy === "deploy" ? "Running…" : "Deploy"}
        </button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} data-testid={t.testId ?? "toast"} role="status">
          <span className="toast-text">{t.text}</span>
          {t.link && (
            <a href={t.link.href} target="_blank" rel="noreferrer">
              {t.link.label}
            </a>
          )}
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
