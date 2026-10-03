import type { FeedMessage, FeedState } from "../types";

export interface FeedHealth {
  tone: "success" | "warning" | "danger" | "muted";
  label: string;
  detail: string;
  perMinute: number;
  lastAt: number | null;
  mismatches: number;
}

/** When a message was produced (its Kafka timestamp), falling back to when we received it. */
export function messageTime(m: FeedMessage): number {
  const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : m.receivedAt;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Is data flowing? Flowing = a message produced in the last minute. */
export function feedHealth(f: FeedState, now: number): FeedHealth {
  const times = f.messages.map(messageTime);
  const lastAt = times.length ? Math.max(...times) : null;
  const perMinute = (f.recent ?? times).filter((t) => t >= now - 60_000).length;
  const mismatches = f.messages.filter((m) => m.check.ok === false).length;
  const base = { perMinute, lastAt, mismatches };
  switch (f.state) {
    case "idle":
      return { ...base, tone: "muted", label: "Off", detail: "Live data is off" };
    case "connecting":
      return { ...base, tone: "muted", label: "Connecting…", detail: f.message ?? "" };
    case "error":
      return { ...base, tone: "danger", label: "Error", detail: f.message ?? "unknown error" };
  }
  if (perMinute > 0) {
    return { ...base, tone: mismatches ? "warning" : "success", label: `Flowing · ${perMinute}/min`, detail: `last message ${ago(now - lastAt!)}` };
  }
  return {
    ...base,
    tone: "warning",
    label: "Quiet",
    detail: lastAt ? `no messages in the last minute; last one ${ago(now - lastAt)}` : "connected, no messages yet",
  };
}
