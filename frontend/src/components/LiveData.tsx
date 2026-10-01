import { useEffect, useState } from "react";
import { ApiError, peek } from "../api";
import { ago, feedHealth, messageTime } from "../lib/feedHealth";
import { useStudio } from "../store";
import type { FeedMessage, SinkId } from "../types";

const SINKS: SinkId[] = ["InputSink", "OutputSink"];
const RETRY_MS = 3000;

/** What a feed depends on; the feed restarts (debounced) when it changes. */
function useSinkKey(sink: SinkId): string {
  return useStudio((s) => {
    const node = s.nodes.find((n) => n.id === sink)?.data.spec.sink;
    if (!node?.Topic) return "";
    const schema = node.Ontology ? s.meta?.schemas[node.Ontology] : undefined;
    return JSON.stringify([s.meta?.name, node.Topic, node.Ontology, schema, node.ConnectionSettings ?? {}]);
  });
}

function useFeed(sink: SinkId, on: boolean) {
  const key = useSinkKey(sink);
  useEffect(() => {
    const { feedStatus } = useStudio.getState();
    if (!on) {
      feedStatus(sink, { state: "idle", message: undefined, messages: [], count: 0 });
      return;
    }
    if (!key) {
      feedStatus(sink, { state: "error", message: `${sink} has no Topic yet`, messages: [], count: 0 });
      return;
    }
    const ctrl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      const s = useStudio.getState();
      s.feedStatus(sink, { state: "connecting", message: undefined });
      try {
        await peek(
          s.graph(),
          sink,
          (e) => {
            const st = useStudio.getState();
            if (e.type === "status") st.feedStatus(sink, { state: e.state, message: e.message, demo: e.demo, partitions: e.partitions });
            else if (e.type === "message") {
              const { type: _type, ...m } = e;
              st.feedMessage(sink, { ...m, receivedAt: Date.now() });
            }
          },
          ctrl.signal,
        );
        if (!ctrl.signal.aborted) useStudio.getState().feedStatus(sink, { state: "error", message: "feed ended; reconnecting…" });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const message = err instanceof ApiError ? err.message : `connection lost (${(err as Error).message})`;
        useStudio.getState().feedStatus(sink, { state: "error", message });
        if (err instanceof ApiError && err.status === 400) return; // a config problem; retrying won't help
      }
      if (!ctrl.signal.aborted) retry = setTimeout(run, RETRY_MS);
    };

    // Debounce: typing a topic shouldn't open a connection per keystroke.
    feedStatus(sink, { messages: [], count: 0 });
    const start = setTimeout(run, 600);
    return () => {
      clearTimeout(start);
      clearTimeout(retry);
      ctrl.abort();
    };
  }, [sink, key, on]);
}

/** Runs the InputSink and OutputSink feeds while Live data is on. Mounted once, in App. */
export function useLiveFeeds() {
  const on = useStudio((s) => s.feedsOn && s.meta !== null);
  useFeed("InputSink", on);
  useFeed("OutputSink", on);
}

export function useNow(intervalMs = 2000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Small In/Out status dots on the "Live data" tab while feeds run. */
export function LiveTabBadges() {
  const feeds = useStudio((s) => s.feeds);
  const now = useNow();
  return (
    <>
      {SINKS.filter((s) => feeds[s].state !== "idle").map((s) => {
        const h = feedHealth(feeds[s], now);
        return (
          <span key={s} className={`mini-status tone-${h.tone}`} title={`${s}: ${h.label} — ${h.detail}`}>
            <span className="dot" />
            {s === "InputSink" ? "In" : "Out"}
          </span>
        );
      })}
    </>
  );
}

function pretty(m: FeedMessage): string {
  if (m.value === null) return "(empty)";
  if (m.encoding === "base64") return `(binary, base64) ${m.value}`;
  try {
    return JSON.stringify(JSON.parse(m.value), null, 2);
  } catch {
    return m.value.replace(/></g, ">\n<");
  }
}

function MessageRow({ m, now }: { m: FeedMessage; now: number }) {
  const [open, setOpen] = useState(false);
  const t = messageTime(m);
  return (
    <li className={`msg${open ? " open" : ""}`}>
      <button className="msg-line" onClick={() => setOpen(!open)} title={m.check.detail}>
        <span className={`msg-check ${m.check.ok === false ? "bad" : m.check.ok ? "good" : ""}`}>
          {m.check.ok === false ? "✕" : m.check.ok ? "✓" : "·"}
        </span>
        <span className="msg-time" title={new Date(t).toISOString()}>
          {ago(now - t)}
        </span>
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
            {m.truncated ? " · preview truncated" : ""}
          </div>
          <pre>{pretty(m)}</pre>
        </div>
      )}
    </li>
  );
}

function FeedColumn({ sink, now }: { sink: SinkId; now: number }) {
  const feed = useStudio((s) => s.feeds[sink]);
  const node = useStudio((s) => s.nodes.find((n) => n.id === sink)?.data.spec.sink);
  const h = feedHealth(feed, now);
  return (
    <section className="feed" data-testid={`feed-${sink}`}>
      <header className="feed-head">
        <div className="feed-title">
          <span className="feed-kind">{sink === "InputSink" ? "Source" : "Output"}</span>
          <span className="feed-topic mono" title="Topic">
            {node?.Topic || "no topic"}
          </span>
          {node?.Ontology && <span className="tag tag-muted">{node.Ontology}</span>}
          {feed.demo && (
            <span className="tag tag-warning" title="Demo mode: generated sample messages">
              demo data
            </span>
          )}
        </div>
        <div className="feed-status">
          <span className={`status status-${h.tone}`} data-testid={`feed-status-${sink}`}>
            <span className="dot" />
            {h.label}
          </span>
          {h.mismatches > 0 && (
            <span className="tag tag-danger" title="Messages that don't match the Ontology schema">
              {h.mismatches} don't match {node?.Ontology}
            </span>
          )}
          <span className="feed-detail" title={h.detail}>
            {h.detail}
          </span>
        </div>
      </header>
      <ul className="msgs">
        {feed.messages.map((m) => (
          <MessageRow key={`${m.partition}:${m.offset}`} m={m} now={now} />
        ))}
        {feed.messages.length === 0 && feed.state === "live" && <li className="empty">Waiting for messages…</li>}
      </ul>
    </section>
  );
}

export function LiveData() {
  const on = useStudio((s) => s.feedsOn);
  const now = useNow();
  if (!on) {
    return (
      <div className="live-off-note">
        <p>
          See whether data is reaching the <b>Source</b> topic and leaving through the <b>Output</b> topic. Studio reads
          the latest messages and follows new ones, read-only: it never joins the pipeline's consumer group and never
          commits offsets.
        </p>
        <button className="btn btn-primary" onClick={() => useStudio.setState({ feedsOn: true })} data-testid="feeds-start">
          Start live data
        </button>
      </div>
    );
  }
  return (
    <div className="feeds">
      {SINKS.map((s) => (
        <FeedColumn key={s} sink={s} now={now} />
      ))}
    </div>
  );
}
