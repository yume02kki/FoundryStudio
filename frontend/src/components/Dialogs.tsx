import { schemaColor } from "../lib/schemaColor";
import { findInfo, versionFor } from "../lib/versions";
import { useStudio } from "../store";
import { runDeploy } from "./TopBar";

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

export function DeployDialog() {
  const open = useStudio((s) => s.deployOpen);
  const validation = useStudio((s) => s.validation);
  const name = useStudio((s) => s.meta?.name);
  const deploysProject = useStudio((s) => s.health?.deploysProject);
  if (!open) return null;
  const close = () => useStudio.setState({ deployOpen: false });
  return (
    <Modal title={`Deploy ${name}`} onClose={close}>
      <p>
        Runs <code>deploy.py deploy --pr</code>: renders the pipeline, pushes a <code>deploy/{name}/…</code> branch to{" "}
        <b>{deploysProject}</b> and opens a merge request. Nothing is pushed to <code>main</code>.
      </p>
      {validation && !validation.ok && (
        <div className="issue">deploy.py reports {validation.errors.length} error(s); the deploy will be refused.</div>
      )}
      <pre className="manifest-preview">{validation?.manifest ?? ""}</pre>
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={runDeploy} data-testid="deploy-confirm">
          Deploy
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
