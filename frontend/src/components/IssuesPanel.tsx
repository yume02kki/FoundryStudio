import { useStudio } from "../store";
import type { Issue } from "../types";

export function focusIssue(issue: Issue) {
  const s = useStudio.getState();
  const edges = issue.edge ? [`${issue.edge[0]}->${issue.edge[1]}`] : [];
  const nodes = issue.nodes.length ? issue.nodes : issue.node ? [issue.node] : [];
  s.select({ nodes: issue.edge ? [] : nodes.slice(0, 1), edges });
  s.setFocus({ nodes, edges });
}

function where(issue: Issue): string {
  if (issue.edge) return `${issue.edge[0]} → ${issue.edge[1]}`;
  if (issue.node) return issue.node;
  if (issue.nodes.length) return issue.nodes.join(", ");
  return "Pipeline";
}

/** Collapsible drawer under the canvas with deploy.py's validation result. */
export function IssuesPanel() {
  const validation = useStudio((s) => s.validation);
  const open = useStudio((s) => s.issuesOpen);
  const toggle = () => useStudio.setState({ issuesOpen: !open });
  const errors = validation?.errors ?? [];

  return (
    <section className={`issues-panel${open ? " open" : ""}`} aria-label="Problems">
      <button className="issues-head" onClick={toggle} aria-expanded={open}>
        <span className={`chevron${open ? " open" : ""}`}>›</span>
        <span className="panel-title">Problems</span>
        <span className={`count${errors.length ? " count-danger" : ""}`}>{errors.length}</span>
        <span className="issues-summary">
          {validation === null
            ? "Validating with deploy.py…"
            : validation.ok
              ? validation.summary
              : "deploy.py validate rejects this manifest. Click a problem to find it."}
        </span>
      </button>
      {open && (
        <div className="issues-body" data-testid="validation-errors">
          {errors.length === 0 && <div className="empty">No problems. deploy.py validate passes.</div>}
          {errors.map((e) => (
            <button key={e.message} className="issue-row" onClick={() => focusIssue(e)}>
              <span className="issue-where">{where(e)}</span>
              <span className="issue-msg">{e.message}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
