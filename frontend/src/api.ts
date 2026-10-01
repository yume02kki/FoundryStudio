import type {
  Catalog,
  DeployEvent,
  DeployHistory,
  FeedMessage,
  Graph,
  Health,
  Issue,
  Layout,
  LoadedPipeline,
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

async function errorOf(res: Response): Promise<ApiError> {
  let body: { detail?: unknown; errors?: Issue[]; log?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const detail = typeof body.detail === "string" ? body.detail : res.statusText;
  return new ApiError(res.status, detail, body.errors ?? [], body.log ?? "");
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) throw await errorOf(res);
  return res.json() as Promise<T>;
}

const pipe = (name: string) => `api/pipelines/${encodeURIComponent(name)}`;

export const api = {
  health: () => call<Health>("api/health"),
  transformers: () => call<{ transformers: TransformerInfo[]; status: WatcherStatus }>("api/transformers"),
  template: () => call<Graph>("api/template"),
  catalog: () => call<Catalog>("api/catalog"),
  saveCatalog: (catalog: Catalog) =>
    call<{ path: string; catalog: Catalog }>("api/catalog", { method: "PUT", json: { catalog } }),
  pipelines: () => call<{ pipelines: PipelineListing[] }>("api/pipelines"),
  load: (name: string) => call<LoadedPipeline>(pipe(name)),
  save: (graph: Graph, layout: Layout) =>
    call<{ path: string; layout: string }>(pipe(graph.name), { method: "PUT", json: { graph, layout } }),
  validate: (graph: Graph, catalog: Catalog | null, signal?: AbortSignal) =>
    call<ValidationResult>("api/validate", { method: "POST", json: { graph, catalog }, signal }),
  checkEdge: (graph: Graph, catalog: Catalog | null, source: string, target: string) =>
    call<{ ok: boolean; message: string | null }>("api/check-edge", {
      method: "POST",
      json: { graph, catalog, source, target },
    }),
  deploys: (name: string) => call<DeployHistory>(`${pipe(name)}/deploys`),
};

/** Read Server-Sent Events from a POST response until the stream ends. */
async function readEvents<T>(res: Response, onEvent: (e: T) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
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
      if (data) onEvent(JSON.parse(data) as T);
    }
  }
}

/**
 * Run a deploy.py operation on a saved pipeline (deploy, rollback, stop), streaming its log.
 * Resolves with the final result event (or error event).
 */
export async function operate(
  name: string,
  op: "deploy" | "rollback" | "stop",
  onLog: (line: string) => void,
  body?: unknown,
): Promise<Extract<DeployEvent, { type: "result" | "error" }>> {
  const res = await fetch(`${pipe(name)}/${op}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok || !res.body) throw await errorOf(res);
  let last: Extract<DeployEvent, { type: "result" | "error" }> | null = null;
  await readEvents<DeployEvent>(res, (e) => {
    if (e.type === "log") onLog(e.line);
    else last = e;
  });
  if (!last) throw new ApiError(0, "the deploy stream ended without a result");
  return last;
}

export type PeekEvent =
  | { type: "endpoint"; endpoint: string; dataset: string; topic: string; schema: string | null; cluster: string }
  | { type: "status"; state: "connecting" | "live" | "error"; message?: string; demo?: boolean; partitions?: number }
  | ({ type: "message" } & Omit<FeedMessage, "receivedAt">)
  | { type: "ping" };

/** Read-only live feed of a dataset (POST + streamed Server-Sent Events). Resolves when the stream ends. */
export async function peek(graph: Graph, node: string, onEvent: (e: PeekEvent) => void, signal: AbortSignal) {
  const res = await fetch("api/peek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, node }),
    signal,
  });
  if (!res.ok || !res.body) throw await errorOf(res);
  await readEvents<PeekEvent>(res, onEvent);
}

export type ServerEvent =
  | { type: "transformer.added"; transformer: TransformerInfo }
  | { type: "transformer.updated"; transformer: TransformerInfo; newVersions: string[] }
  | { type: "transformer.removed"; id: string; name: string }
  | { type: "watcher.status"; status: WatcherStatus };

const EVENT_TYPES = ["transformer.added", "transformer.updated", "transformer.removed", "watcher.status"] as const;

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
