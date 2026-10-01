import { feedHealth } from "../lib/feedHealth";
import { useStudio } from "../store";
import { LiveData, useNow } from "./LiveData";
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

function Problems() {
  const validation = useStudio((s) => s.validation);
  const errors = validation?.errors ?? [];
  return (
    <div className="issues-body" data-testid="validation-errors">
      {errors.length === 0 && (
        <div className="empty">{validation ? `No problems. ${validation.summary ?? ""}` : "Validating with deploy.py…"}</div>
      )}
      {errors.map((e) => (
        <button key={e.message} className="issue-row" onClick={() => focusIssue(e)}>
          <span className="issue-where">{where(e)}</span>
          <span className="issue-msg">{e.message}</span>
        </button>
      ))}
    </div>
  );
}

function FeedPill({ sink }: { sink: "InputSink" | "OutputSink" }) {
  const feed = useStudio((s) => s.feeds[sink]);
  const now = useNow();
  if (feed.state === "idle") return null;
  const h = feedHealth(feed, now);
  return (
    <span className={`mini-status tone-${h.tone}`} title={`${sink}: ${h.label} — ${h.detail}`}>
      <span className="dot" />
      {sink === "InputSink" ? "In" : "Out"}
    </span>
  );
}

/** Drawer under the canvas: deploy.py's problems, and live data from the sink topics. */
export function BottomPanel() {
  const validation = useStudio((s) => s.validation);
  const open = useStudio((s) => s.issuesOpen);
  const tab = useStudio((s) => s.drawerTab);
  const feedsOn = useStudio((s) => s.feedsOn);
  const errors = validation?.errors ?? [];
  const show = (t: "problems" | "live") =>
    useStudio.setState({ drawerTab: t, issuesOpen: !(open && tab === t) });

  return (
    <section className={`bottom-panel${open ? " open" : ""}${open && tab === "live" ? " tall" : ""}`} aria-label="Problems and live data">
      <div className="bottom-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={open && tab === "problems"}
          className={`bottom-tab${open && tab === "problems" ? " active" : ""}`}
          onClick={() => show("problems")}
          data-testid="tab-problems"
        >
          Problems <span className={`count${errors.length ? " count-danger" : ""}`}>{errors.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={open && tab === "live"}
          className={`bottom-tab${open && tab === "live" ? " active" : ""}`}
          onClick={() => show("live")}
          data-testid="tab-live"
        >
          Live data <FeedPill sink="InputSink" />
          <FeedPill sink="OutputSink" />
        </button>
        <span className="bottom-summary">
          {tab === "problems" || !open
            ? validation === null
              ? "Validating with deploy.py…"
              : validation.ok
                ? validation.summary
                : "deploy.py validate rejects this manifest. Click a problem to find it."
            : "Read-only: never joins the pipeline's consumer group, never commits offsets."}
        </span>
        {open && tab === "live" && feedsOn && (
          <button className="btn btn-small" onClick={() => useStudio.setState({ feedsOn: false })} data-testid="feeds-stop">
            Stop
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => useStudio.setState({ issuesOpen: !open })}
          aria-label={open ? "Collapse panel" : "Expand panel"}
        >
          <span className={`chevron${open ? " open-up" : ""}`}>›</span>
        </button>
      </div>
      {open && (tab === "problems" ? <Problems /> : <LiveData />)}
    </section>
  );
}
