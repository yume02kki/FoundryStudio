import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { api, subscribe } from "./api";
import { AssetBrowser } from "./components/AssetBrowser";
import { Canvas } from "./components/Canvas";
import { Toasts, VersionPicker } from "./components/Dialogs";
import { Inspector } from "./components/Inspector";
import { useLiveFeeds } from "./components/LiveData";
import { TopBar } from "./components/TopBar";
import { useStudio } from "./store";
import type { Graph } from "./types";

function setUrl(params: Record<string, string> | null) {
  const url = new URL(window.location.href);
  url.search = params ? new URLSearchParams(params).toString() : "";
  window.history.replaceState(null, "", url);
}

function useValidation() {
  const revision = useStudio((s) => s.revision);
  const hasMeta = useStudio((s) => s.meta !== null);
  useEffect(() => {
    if (!hasMeta) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      useStudio.setState({ validating: true });
      try {
        const s = useStudio.getState();
        const validation = await api.validate(s.graph(), ctrl.signal);
        if (!ctrl.signal.aborted) useStudio.setState({ validation });
      } catch (e) {
        if (!ctrl.signal.aborted) console.warn("validate failed", e);
      } finally {
        if (!ctrl.signal.aborted) useStudio.setState({ validating: false });
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [revision, hasMeta]);
}

function useLiveUpdates() {
  useEffect(() => {
    const resync = async () => {
      const t = await api.transformers();
      useStudio.getState().setTransformers(t.transformers);
      useStudio.setState({ watcher: t.status, live: true });
    };
    return subscribe(
      (e) => {
        const s = useStudio.getState();
        switch (e.type) {
          case "transformer.added":
            s.upsertTransformer(e.transformer, "added");
            s.toast({ kind: "info", text: `New transformer: ${e.transformer.name} (${e.transformer.input} → ${e.transformer.output})` });
            break;
          case "transformer.updated":
            s.upsertTransformer(e.transformer, "updated");
            if (e.newVersions.length) s.toast({ kind: "info", text: `New version: ${e.newVersions.join(", ")}` });
            break;
          case "transformer.removed":
            s.removeTransformer(e.id);
            s.toast({ kind: "warning", text: `Transformer removed from its repo: ${e.name}` });
            break;
          case "watcher.status":
            useStudio.setState({ watcher: e.status });
            break;
          case "pipelines.changed":
            void api.pipelines().then((p) => useStudio.setState({ pipelines: p.pipelines }));
            s.toast({ kind: "info", text: `Pipeline updated from ${e.project}` });
            break;
        }
      },
      () => void resync().catch(() => useStudio.setState({ live: false })),
      () => useStudio.setState({ live: false }),
    );
  }, []);
}

/** Profiles (from the pipeline's Configs repo) and schemas, for the pickers and the Inspector. */
async function loadCatalog(configs: Graph["configs"]) {
  try {
    const catalog = await api.catalog(configs);
    useStudio.setState({ catalog });
    for (const [what, error] of Object.entries(catalog.errors)) {
      useStudio.getState().toast({ kind: "warning", text: `Couldn't read the ${what}: ${error}` }, 10000);
    }
  } catch (e) {
    useStudio.getState().toast({ kind: "error", text: `Couldn't read profiles and schemas: ${(e as Error).message}` }, 10000);
  }
}

export default function App() {
  useValidation();
  useLiveUpdates();
  useLiveFeeds();

  const confirmDiscard = () => !useStudio.getState().dirty || window.confirm("Discard unsaved changes?");

  const openNew = useCallback(async () => {
    if (!confirmDiscard()) return;
    const template = await api.template();
    useStudio.getState().load(template, { version: 1, positions: {} }, { kind: "new" });
    setUrl({ new: "1" });
    await loadCatalog(template.configs);
  }, []);

  const open = useCallback(async (folder: string) => {
    if (!confirmDiscard()) return;
    try {
      const loaded = await api.load(folder);
      useStudio.getState().load(loaded.graph, loaded.layout, { kind: "saved", folder });
      setUrl({ pipeline: folder });
      for (const w of loaded.graph.warnings ?? []) useStudio.getState().toast({ kind: "warning", text: w }, 10000);
      await loadCatalog(loaded.graph.configs);
    } catch (e) {
      useStudio.getState().toast({ kind: "error", text: `Couldn't open ${folder}: ${(e as Error).message}` }, 10000);
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [health, pipelines] = await Promise.all([api.health(), api.pipelines()]);
      useStudio.setState({ health, watcher: health.watcher, pipelines: pipelines.pipelines });
      const params = new URLSearchParams(window.location.search);
      const folder = params.get("pipeline");
      if (folder) await open(folder);
      else if (params.has("new")) await openNew();
      else if (pipelines.pipelines[0]) await open(pipelines.pipelines[0].folder);
      else await openNew();
    })().catch((e) => useStudio.getState().toast({ kind: "error", text: `Backend unreachable: ${e.message}` }, 0));
  }, [open, openNew]);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar onOpen={open} onNew={openNew} />
        <div className="workspace">
          <div className="upper">
            <Canvas />
            <Inspector />
          </div>
          <AssetBrowser />
        </div>
        <VersionPicker />
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}
