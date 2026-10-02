import { useEffect, useMemo, useState } from "react";
import { ApiError, peek } from "../api";
import { ago, feedHealth, messageTime } from "../lib/feedHealth";
import { schemaColor } from "../lib/schemaColor";
import { diffRecords, edgeDataset, liveKeys, pairRecords, stageFeeds, stageStats, stages, type Pair, type StageStats } from "../lib/stages";
import { useStudio } from "../store";
import { datasetName, datasetNode, isDatasetNode, type FeedMessage, type FeedState } from "../types";

const RETRY_MS = 3000;

// --------------------------------------------------------------------------- feeds

/** Open one feed (the dataset `key`) until aborted; reconnects after errors. */
function runFeed(key: string, signal: AbortSignal) {
  let retry: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const s = useStudio.getState();
    s.feedStatus(key, { state: "connecting", message: undefined });
    try {
      await peek(
        s.graph(),
        datasetNode(key),
        (e) => {
          const st = useStudio.getState();
          if (e.type === "endpoint") st.feedStatus(key, { topic: e.topic, schema: e.schema, cluster: e.cluster });
          else if (e.type === "status") st.feedStatus(key, { state: e.state, message: e.message, demo: e.demo, partitions: e.partitions });
          else if (e.type === "message") {
            const { type: _type, ...m } = e;
            st.feedMessage(key, { ...m, receivedAt: Date.now() });
          }
        },
        signal,
      );
      if (!signal.aborted) useStudio.getState().feedStatus(key, { state: "error", message: "feed ended; reconnecting…" });
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof ApiError ? err.message : `connection lost (${(err as Error).message})`;
      useStudio.getState().feedStatus(key, { state: "error", message });
      if (err instanceof ApiError && err.status === 400) return; // a config problem; retrying won't help
    }
    if (!signal.aborted) retry = setTimeout(run, RETRY_MS);
  };
  void run();
  signal.addEventListener("abort", () => clearTimeout(retry));
}

const MAX_FEEDS = 8; // the backend serves at most 8 concurrent feeds

/** The pipeline graph from the canvas, stable across renders while nodes/edges don't change. */
function useGraph() {
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  return useMemo(
    () => ({ nodes: nodes.map((n) => n.data.spec), edges: edges.map((e) => ({ source: e.source, target: e.target })) }),
    [nodes, edges],
  );
}

const graphOf = (s: ReturnType<typeof useStudio.getState>) => ({
  nodes: s.nodes.map((n) => n.data.spec),
  edges: s.edges.map((e) => ({ source: e.source, target: e.target })),
});

/**
 * While Live data is on, follows every dataset on the canvas, so the canvas shows data
 * flowing everywhere and switching between nodes is instant. Very large pipelines fall
 * back to the selected stage's datasets. Graph edits restart the feeds
 * (debounced): a dataset or a connection setting may have changed. Mounted once, in App.
 */
export function useLiveFeeds() {
  const on = useStudio((s) => s.feedsOn && s.meta !== null);
  const revision = useStudio((s) => s.revision);
  const stage = useStudio((s) => s.liveStage);
  const all = useStudio((s) => liveKeys(graphOf(s)).join("|"));
  const capped = all.split("|").length > MAX_FEEDS;
  const keysSpec = capped ? `${all}#${stage}` : all;

  useEffect(() => {
    if (!on) {
      useStudio.setState({ feeds: {} });
      return;
    }
    const graph = useStudio.getState().graph();
    let keys = keysSpec.split("#")[0].split("|").filter(Boolean);
    if (keys.length > MAX_FEEDS) {
      const st = useStudio.getState().liveStage;
      keys = st ? (({ inputs, outputs }) => [...new Set([...inputs, ...outputs])])(stageFeeds(graph, st)) : [];
    }
    useStudio.setState({ feeds: Object.fromEntries(keys.map((k) => [k, { state: "connecting", messages: [], count: 0 } as FeedState])) });
    const ctrl = new AbortController();
    const start = setTimeout(() => keys.forEach((k) => runFeed(k, ctrl.signal)), 500);
    return () => {
      clearTimeout(start);
      ctrl.abort();
    };
  }, [on, revision, keysSpec]);

  // Clicking on the canvas drives what Live data shows: a node shows its data, a
  // connection the dataset it carries, empty canvas the overview.
  const selectedNode = useStudio((s) => s.nodes.find((n) => n.selected)?.id ?? null);
  const selectedEdge = useStudio((s) => s.edges.find((e) => e.selected)?.id ?? null);
  useEffect(() => {
    if (!useStudio.getState().feedsOn) return;
    const edge = selectedEdge ? useStudio.getState().edges.find((e) => e.id === selectedEdge) : undefined;
    const liveStage = selectedNode ?? (edge ? datasetNode(edgeDataset(edge.source, edge.target)) : null);
    useStudio.setState({ liveStage, bottomTab: "live" });
  }, [selectedNode, selectedEdge]);
}

export function useNow(intervalMs = 2000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// --------------------------------------------------------------------------- small pieces

function StatusPill({ feed, now, testId }: { feed: FeedState | undefined; now: number; testId?: string }) {
  if (!feed) return null;
  const h = feedHealth(feed, now);
  return (
    <span className={`status status-${h.tone}`} data-testid={testId} title={h.detail}>
      <span className="dot" />
      {h.label}
    </span>
  );
}

function TopicLabel({ feed, fallback }: { feed: FeedState | undefined; fallback: string }) {
  return (
    <span className="feed-topic mono" title={feed?.cluster ? `Topic on cluster ${feed.cluster}` : "Topic"}>
      {feed?.topic || fallback}
      {feed?.schema && (
        <span className="feed-schema" style={{ color: schemaColor(feed.schema) }}>
          {" "}
          {feed.schema}
        </span>
      )}
    </span>
  );
}

/** Status dots on the "Live data" tab while feeds run. */
export function LiveTabBadges() {
  const feeds = useStudio((s) => s.feeds);
  const now = useNow();
  return (
    <>
      {Object.entries(feeds)
        .filter(([, f]) => f.state !== "idle")
        .map(([k, f]) => {
          const h = feedHealth(f, now);
          return <span key={k} className={`mini-dot tone-${h.tone}`} title={`${f.topic ?? k}: ${h.label}`} />;
        })}
    </>
  );
}

/** Live numbers on a canvas node while Live data is on; click opens its data. */
export function NodeActivity({ node }: { node: string }) {
  const on = useStudio((s) => s.feedsOn);
  const feeds = useStudio((s) => s.feeds);
  const graph = useGraph();
  const now = useNow();
  if (!on) return null;
  const st = stageStats(graph, node, feeds, now);
  if (st.label === "Off") return null;
  const label = st.label;
  return (
    <button
      className={`activity tone-${st.tone} nodrag`}
      data-testid={`activity-${node}`}
      title={st.lastAt ? `last message ${ago(now - st.lastAt)}` : undefined}
      onClick={(e) => {
        e.stopPropagation();
        useStudio.setState({ bottomTab: "live", liveStage: node });
      }}
    >
      <span className="dot" />
      {label}
      {st.dropped > 0 && <span className="activity-bad"> · {st.dropped} dropped</span>}
    </button>
  );
}

/** Is data flowing on the dataset a connection carries? Drives the edge animation. */
export function useEdgeFlow(source: string, target: string): { active: boolean; title: string } {
  const key = edgeDataset(source, target);
  const feed = useStudio((s) => (s.feedsOn ? s.feeds[key] : undefined));
  const now = useNow();
  if (!feed) return { active: false, title: "" };
  const h = feedHealth(feed, now);
  const recent = h.lastAt !== null && now - h.lastAt < 15_000;
  return { active: feed.state === "live" && recent, title: `${feed.topic ?? key}: ${h.label}, ${h.detail}` };
}

function pretty(m: FeedMessage | undefined): string {
  if (!m) return "";
  if (m.value === null) return "(empty)";
  if (m.encoding === "base64") return `(binary, base64) ${m.value}`;
  try {
    return JSON.stringify(JSON.parse(m.value), null, 2);
  } catch {
    return m.value.replace(/></g, ">\n<");
  }
}

function clip(s: string, n = 48) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// --------------------------------------------------------------------------- single topic

function MessageRow({ m, now }: { m: FeedMessage; now: number }) {
  const [open, setOpen] = useState(false);
  const t = messageTime(m);
  return (
    <li className={`msg${open ? " open" : ""}`}>
      <button className="msg-line" onClick={() => setOpen(!open)} title={m.check.detail}>
        <span className={`msg-check ${m.check.ok === false ? "bad" : m.check.ok ? "good" : ""}`}>
          {m.check.ok === false ? "✕" : m.check.ok ? "✓" : "·"}
        </span>
        <span className="msg-time">{ago(now - t)}</span>
        <span className="msg-pos">
          p{m.partition}@{m.offset}
        </span>
        <span className="msg-value">{m.value ?? "(empty)"}</span>
      </button>
      {open && (
        <div className="msg-detail">
          <div className={`msg-check-detail ${m.check.ok === false ? "bad" : ""}`}>{m.check.detail}</div>
          <div className="msg-meta">
            {new Date(t).toLocaleString()} · partition {m.partition} · offset {m.offset} · {m.size} bytes
            {m.key ? ` · key ${m.key}` : ""}
          </div>
          <pre>{pretty(m)}</pre>
        </div>
      )}
    </li>
  );
}

function TopicView({ feedKey, title, testId }: { feedKey: string; title: string; testId: string }) {
  const feed = useStudio((s) => s.feeds[feedKey]);
  const now = useNow();
  const h = feed ? feedHealth(feed, now) : null;
  return (
    <section className="feed" data-testid={`feed-${testId}`}>
      <header className="feed-head">
        <div className="feed-title">
          <span className="feed-kind">{title}</span>
          <TopicLabel feed={feed} fallback="" />
          {feed?.demo && <span className="tag tag-warning">demo data</span>}
        </div>
        <div className="feed-status">
          <StatusPill feed={feed} now={now} testId={`feed-status-${testId}`} />
          {h && h.mismatches > 0 && <span className="tag tag-danger">{h.mismatches} don't match {feed?.schema}</span>}
          <span className="feed-detail">{h?.detail}</span>
        </div>
      </header>
      <ul className="msgs">
        {feed?.messages.map((m) => <MessageRow key={`${m.partition}:${m.offset}`} m={m} now={now} />)}
        {feed?.state === "live" && feed.messages.length === 0 && <li className="empty">Waiting for messages…</li>}
        {!feed && <li className="empty">Not watching this topic.</li>}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- transformer: input vs output

const STATUS_LABEL: Record<Pair["status"], string> = {
  transformed: "→",
  dropped: "dropped",
  pending: "…",
  "out-only": "out only",
  unkeyed: "no key",
};

function PairRow({ p, now }: { p: Pair; now: number }) {
  const [open, setOpen] = useState(false);
  const diff = p.input && p.output ? diffRecords(p.input.value, p.output.value) : null;
  const changes = diff
    ? [...(diff.format ? [`${diff.format[0]}→${diff.format[1]}`] : []), ...diff.changed.map((c) => c.field), ...diff.added.map((a) => `+${a}`), ...diff.removed.map((r) => `−${r}`)]
    : [];
  return (
    <li className={`pair pair-${p.status}${open ? " open" : ""}`}>
      <button className="pair-line" onClick={() => setOpen(!open)}>
        <span className="msg-time">{ago(now - p.at)}</span>
        <span className="pair-value">{p.input ? clip(p.input.value ?? "(empty)", 200) : <i className="muted">not in view</i>}</span>
        <span className={`pair-status status-${p.status}`} title={statusHelp(p.status)}>
          {STATUS_LABEL[p.status]}
        </span>
        <span className="pair-value">
          {p.output ? clip(p.output.value ?? "(empty)", 200) : <i className="muted">{p.status === "dropped" ? "no output" : "…"}</i>}
        </span>
        <span className="pair-changes">{changes.length ? changes.join(", ") : p.status === "transformed" ? "unchanged" : ""}</span>
      </button>
      {open && (
        <div className="pair-detail">
          <div className="pair-meta">
            record <span className="mono">{p.id}</span> · {statusHelp(p.status)}
          </div>
          {diff && (
            <ul className="diff">
              {diff.format && (
                <li>
                  <b>format</b> {diff.format[0]} → {diff.format[1]}
                </li>
              )}
              {diff.changed.map((c) => (
                <li key={c.field}>
                  <b>{c.field}</b> <span className="before mono">{clip(c.before)}</span> →{" "}
                  <span className="after mono">{clip(c.after)}</span>
                </li>
              ))}
              {diff.added.map((a) => (
                <li key={a}>
                  <b>{a}</b> added
                </li>
              ))}
              {diff.removed.map((r) => (
                <li key={r}>
                  <b>{r}</b> removed
                </li>
              ))}
              {diff.unchanged.length > 0 && <li className="muted">unchanged: {diff.unchanged.join(", ")}</li>}
            </ul>
          )}
          <div className="pair-pre">
            <div>
              <div className="pair-pre-title">Input {p.input && <CheckMark m={p.input} />}</div>
              <pre>{pretty(p.input)}</pre>
            </div>
            <div>
              <div className="pair-pre-title">Output {p.output && <CheckMark m={p.output} />}</div>
              <pre>{pretty(p.output)}</pre>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function CheckMark({ m }: { m: FeedMessage }) {
  return (
    <span className={`msg-check ${m.check.ok === false ? "bad" : m.check.ok ? "good" : ""}`} title={m.check.detail}>
      {m.check.ok === false ? "✕" : m.check.ok ? "✓" : ""} {m.check.detail}
    </span>
  );
}

function statusHelp(s: Pair["status"]): string {
  return {
    transformed: "the transformer produced an output for this record",
    dropped: "no output for this record after 5 s: the transformer dropped it (or it's stuck)",
    pending: "waiting for the transformer's output",
    "out-only": "output whose input record is older than the input window",
    unkeyed: "no Kafka key or guid to match input and output",
  }[s];
}

function TransformView({ stage, now }: { stage: string; now: number }) {
  const graph = useStudio((s) => s.graph);
  const feeds = useStudio((s) => s.feeds);
  const { inputs, outputs } = stageFeeds(graph(), stage);
  const inFeeds = inputs.map((k) => feeds[k]).filter(Boolean) as FeedState[];
  const output = outputs[0];
  const outFeed = output ? feeds[output] : undefined;
  const inMsgs = inFeeds.flatMap((f) => f.messages);
  const pairs = pairRecords(inMsgs, outFeed?.messages ?? [], now).slice(0, 120);
  const count = (s: Pair["status"]) => pairs.filter((p) => p.status === s).length;
  const rate = (f: FeedState | undefined) => (f ? feedHealth(f, now).perMinute : 0);
  const inRate = inFeeds.reduce((n, f) => n + rate(f), 0);
  const demo = inFeeds.some((f) => f.demo) || outFeed?.demo;

  return (
    <section className="transform" data-testid={`transform-${stage}`}>
      <header className="transform-head">
        <div className="transform-side">
          <span className="feed-kind">In</span>
          {inputs.map((k) => (
            <span key={k} className="transform-topic">
              <TopicLabel feed={feeds[k]} fallback={k} /> <StatusPill feed={feeds[k]} now={now} />
            </span>
          ))}
        </div>
        <div className="transform-mid">
          <b>{stage}</b>
          <span className="transform-stats" data-testid={`transform-stats-${stage}`}>
            {inRate}/min in · {rate(outFeed)}/min out · {count("transformed")} transformed · {count("dropped")} dropped
          </span>
          {demo && <span className="tag tag-warning">demo data</span>}
        </div>
        <div className="transform-side right">
          <span className="feed-kind">Out</span>
          {outputs.length === 0 && <span className="transform-topic muted">not wired</span>}
          {outputs.map((k) => (
            <span key={k} className="transform-topic">
              <TopicLabel feed={feeds[k]} fallback={k} /> <StatusPill feed={feeds[k]} now={now} />
            </span>
          ))}
        </div>
      </header>
      <ul className="pairs">
        {pairs.map((p) => (
          <PairRow key={p.id} p={p} now={now} />
        ))}
        {pairs.length === 0 && <li className="empty">Waiting for records…</li>}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- overview

function overviewLabel(st: StageStats, dataset: boolean): string {
  if (dataset || ["Off", "Error", "Connecting…"].includes(st.label)) return st.label;
  if (st.tone === "danger") return "Not producing";
  return st.inRate || st.outRate ? "Running" : "Idle";
}

const stageLabel = (stage: string) => (isDatasetNode(stage) ? `≋ ${datasetName(stage)}` : `⚙ ${stage}`);

function Overview({ order, now }: { order: string[]; now: number }) {
  const feeds = useStudio((s) => s.feeds);
  const graph = useGraph();
  return (
    <div className="overview" data-testid="live-overview">
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Reads</th>
            <th>Writes</th>
            <th>Status</th>
            <th className="num">In/min</th>
            <th className="num">Out/min</th>
            <th className="num">Dropped</th>
            <th>Last message</th>
          </tr>
        </thead>
        <tbody>
          {order.map((stage) => {
            const st = stageStats(graph, stage, feeds, now);
            const { inputs, outputs } = stageFeeds(graph, stage);
            const dataset = isDatasetNode(stage);
            return (
              <tr key={stage} onClick={() => useStudio.setState({ liveStage: stage })} data-testid={`overview-${stage}`}>
                <td className={`ov-stage${dataset ? " mono" : ""}`}>{stageLabel(stage)}</td>
                <td className="mono muted">{dataset ? "" : inputs.join(", ")}</td>
                <td className="mono muted">{dataset ? "" : outputs.join(", ") || "—"}</td>
                <td>
                  <span className={`status status-${st.tone}`}>
                    <span className="dot" />
                    {overviewLabel(st, dataset)}
                  </span>
                </td>
                <td className="num">{dataset ? "" : st.inRate}</td>
                <td className="num">{st.outRate}</td>
                <td className={`num${st.dropped ? " bad" : ""}`}>{dataset ? "" : st.dropped}</td>
                <td className="muted">{st.lastAt ? ago(now - st.lastAt) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note">Click a stage here, or a node or connection on the canvas, to see its records.</p>
    </div>
  );
}

// --------------------------------------------------------------------------- the tab

export function LiveData() {
  const on = useStudio((s) => s.feedsOn);
  const stage = useStudio((s) => s.liveStage);
  const order = useStudio((s) => stages(graphOf(s)).join("|")).split("|");
  const now = useNow();

  if (!on) {
    return (
      <div className="live-off-note">
        <p>
          Watch data move through the pipeline: what arrives on each dataset and what each transformer turns it into.
          Read-only: Studio never joins the pipeline's consumer groups and never commits offsets.
        </p>
        <button className="btn btn-primary" onClick={() => useStudio.setState({ feedsOn: true })} data-testid="feeds-start">
          Start live data
        </button>
      </div>
    );
  }
  return (
    <div className="live">
      <nav className="stage-strip" aria-label="Pipeline stage">
        <button
          className={`stage${stage === null ? " active" : ""}`}
          onClick={() => useStudio.setState({ liveStage: null })}
          data-testid="stage-overview"
        >
          Overview
        </button>
        <span className="stage-sep" />
        {order.map((s, i) => (
          <span key={s} className="stage-step">
            {i > 0 && <span className="stage-arrow">→</span>}
            <button
              className={`stage${s === stage ? " active" : ""}`}
              onClick={() => useStudio.setState({ liveStage: s })}
              data-testid={`stage-${s}`}
            >
              {isDatasetNode(s) ? `≋ ${datasetName(s)}` : s}
            </button>
          </span>
        ))}
      </nav>
      {stage === null ? (
        <Overview order={order} now={now} />
      ) : isDatasetNode(stage) ? (
        <TopicView feedKey={datasetName(stage)} title="Dataset" testId={datasetName(stage)} />
      ) : (
        <TransformView stage={stage} now={now} />
      )}
    </div>
  );
}
