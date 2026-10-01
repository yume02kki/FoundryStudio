import type {
  DeployResult,
  FeedMessage,
  Graph,
  Health,
  Issue,
  Layout,
  LoadedPipeline,
  MergeRequest,
  PipelineListing,
  TransformerInfo,
  ValidationResult,
  WatcherStatus,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: Issue[] = [],
    public log = "",
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    let body: { detail?: unknown; errors?: Issue[]; log?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    const detail = typeof body.detail === "string" ? body.detail : res.statusText;
    throw new ApiError(res.status, detail, body.errors ?? [], body.log ?? "");
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => call<Health>("api/health"),
  transformers: () => call<{ transformers: TransformerInfo[]; status: WatcherStatus }>("api/transformers"),
  template: () => call<Graph>("api/template"),
  pipelines: () => call<{ pipelines: PipelineListing[] }>("api/pipelines"),
  load: (name: string, source?: "draft" | "deployed") =>
    call<LoadedPipeline>(`api/pipelines/${encodeURIComponent(name)}${source ? `?source=${source}` : ""}`),
  save: (graph: Graph, layout: Layout) =>
    call<{ path: string; layout: string }>(`api/pipelines/${encodeURIComponent(graph.name)}`, {
      method: "PUT",
      json: { graph, layout },
    }),
  validate: (graph: Graph, signal?: AbortSignal) =>
    call<ValidationResult>("api/validate", { method: "POST", json: { graph }, signal }),
  checkEdge: (graph: Graph, source: string, target: string) =>
    call<{ ok: boolean; message: string | null }>("api/check-edge", {
      method: "POST",
      json: { graph, source, target },
    }),
  deploy: (graph: Graph) => call<DeployResult>("api/deploy", { method: "POST", json: { graph } }),
  latestMr: () => call<{ mr: MergeRequest | null }>("api/merge-requests/latest"),
};

export type PeekEvent =
  | { type: "status"; state: "connecting" | "live" | "error"; message?: string; demo?: boolean; partitions?: number }
  | ({ type: "message" } & Omit<FeedMessage, "receivedAt">)
  | { type: "ping" };

/** Read-only live feed of a sink topic (POST + streamed Server-Sent Events). Resolves when the stream ends. */
export async function peek(graph: Graph, node: string, onEvent: (e: PeekEvent) => void, signal: AbortSignal) {
  const res = await fetch("api/peek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, node }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as PeekEvent);
    }
  }
}

export type ServerEvent =
  | { type: "transformer.added"; transformer: TransformerInfo }
  | { type: "transformer.updated"; transformer: TransformerInfo; newVersions: string[] }
  | { type: "transformer.removed"; id: string; name: string }
  | { type: "mr.updated"; mr: MergeRequest }
  | { type: "pipelines.changed"; head: string }
  | { type: "watcher.status"; status: WatcherStatus };

const EVENT_TYPES = [
  "transformer.added",
  "transformer.updated",
  "transformer.removed",
  "mr.updated",
  "pipelines.changed",
  "watcher.status",
] as const;

/** Server-Sent Events from /api/events. `onHello` fires on every (re)connect so callers can resync. */
export function subscribe(onEvent: (e: ServerEvent) => void, onHello: () => void, onDown: () => void): () => void {
  const source = new EventSource("api/events");
  source.addEventListener("hello", () => onHello());
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (msg) => onEvent(JSON.parse((msg as MessageEvent).data) as ServerEvent));
  }
  source.onerror = () => onDown();
  return () => source.close();
}
