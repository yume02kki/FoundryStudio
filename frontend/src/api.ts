import type {
  Catalog,
  FeedMessage,
  Graph,
  Health,
  Issue,
  Layout,
  LoadedPipeline,
  PipelineListing,
  ProcessorInfo,
  ValidationResult,
  WatcherStatus,
  WorkspaceDataset,
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

const pipe = (folder: string) => `api/pipelines/${encodeURIComponent(folder)}`;

type Saved = { path: string; layout: string; folder: string };

export const api = {
  health: () => call<Health>("api/health"),
  processors: () => call<{ processors: ProcessorInfo[]; status: WatcherStatus }>("api/processors"),
  template: () => call<Graph>("api/template"),
  /** Profiles from the manifest's Configs repo (the default one without), and the schemas. */
  catalog: (configs: Graph["configs"] = {}) => {
    const q = new URLSearchParams();
    if (configs.Repo) q.set("repo", configs.Repo);
    if (configs.Ref) q.set("ref", configs.Ref);
    return call<Catalog>(`api/catalog?${q}`);
  },
  pipelines: () => call<{ pipelines: PipelineListing[] }>("api/pipelines"),
  datasets: () => call<{ datasets: WorkspaceDataset[] }>("api/datasets"),
  load: (folder: string) => call<LoadedPipeline>(pipe(folder)),
  /** Save to the pipeline's folder, or (folder null) create a new folder named after it. */
  save: (folder: string | null, graph: Graph, layout: Layout) =>
    folder
      ? call<Saved>(pipe(folder), { method: "PUT", json: { graph, layout } })
      : call<Saved>("api/pipelines", { method: "POST", json: { graph, layout } }),
  validate: (graph: Graph, signal?: AbortSignal) =>
    call<ValidationResult>("api/validate", { method: "POST", json: { graph }, signal }),
  checkEdge: (graph: Graph, source: string, target: string) =>
    call<{ ok: boolean; message: string | null }>("api/check-edge", { method: "POST", json: { graph, source, target } }),
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
  | { type: "processor.added"; processor: ProcessorInfo }
  | { type: "processor.updated"; processor: ProcessorInfo; newVersions: string[] }
  | { type: "processor.removed"; id: string; name: string }
  | { type: "watcher.status"; status: WatcherStatus }
  | { type: "pipelines.changed"; project: string };

const EVENT_TYPES = ["processor.added", "processor.updated", "processor.removed", "watcher.status", "pipelines.changed"] as const;

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
