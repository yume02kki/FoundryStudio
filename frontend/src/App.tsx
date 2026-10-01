import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { api, subscribe } from "./api";
import { Canvas } from "./components/Canvas";
import { DeployDialog, Toasts, VersionPicker } from "./components/Dialogs";
import { Inspector } from "./components/Inspector";
import { IssuesPanel } from "./components/IssuesPanel";
import { Library } from "./components/Library";
import { saveDraft, TopBar } from "./components/TopBar";
import { SINK, SOURCE } from "./types";
import { useStudio } from "./store";

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
        const validation = await api.validate(useStudio.getState().graph(), ctrl.signal);
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
      const [t, mr] = await Promise.all([api.transformers(), api.latestMr()]);
      useStudio.getState().setTransformers(t.transformers);
      useStudio.setState({ watcher: t.status, mr: mr.mr, live: true });
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
          case "mr.updated":
            useStudio.setState({ mr: e.mr });
            break;
          case "pipelines.changed":
            api.pipelines().then((p) => useStudio.setState({ pipelines: p.pipelines }));
            break;
          case "watcher.status":
            useStudio.setState({ watcher: e.status });
            break;
        }
      },
      () => void resync().catch(() => useStudio.setState({ live: false })),
      () => useStudio.setState({ live: false }),
    );
  }, []);
}

function useTheme() {
  const theme = useStudio((s) => s.theme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  useValidation();
  useLiveUpdates();
  useTheme();
  useShortcuts();

  const confirmDiscard = () => !useStudio.getState().dirty || window.confirm("Discard unsaved changes?");

  const openNew = useCallback(async () => {
    if (!confirmDiscard()) return;
    const template = await api.template();
    useStudio.getState().load(template, { version: 1, positions: { [SOURCE]: { x: 0, y: 0 }, [SINK]: { x: 1000, y: 0 } } }, { kind: "new" });
    setUrl({ new: "1" });
  }, []);

  const open = useCallback(async (name: string, source?: "draft" | "deployed") => {
    if (!confirmDiscard()) return;
    try {
      const loaded = await api.load(name, source);
      useStudio.getState().load(loaded.graph, loaded.layout, { kind: loaded.source, name });
      setUrl({ pipeline: name, source: loaded.source });
      for (const w of loaded.graph.warnings ?? []) useStudio.getState().toast({ kind: "warning", text: w }, 10000);
    } catch (e) {
      useStudio.getState().toast({ kind: "error", text: `Couldn't open ${name}: ${(e as Error).message}` }, 10000);
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
      const name = params.get("pipeline");
      if (name) await open(name, (params.get("source") as "draft" | "deployed") ?? undefined);
      else if (params.has("new")) await openNew();
      else {
        const first = pipelines.pipelines.find((p) => p.deployed) ?? pipelines.pipelines[0];
        if (first) await open(first.name, first.deployed ? "deployed" : "draft");
        else await openNew();
      }
    })().catch((e) => useStudio.getState().toast({ kind: "error", text: `Backend unreachable: ${e.message}` }, 0));
  }, [open, openNew]);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar onOpen={open} onNew={openNew} />
        <main className="workspace">
          <Library />
          <div className="center">
            <Canvas />
            <IssuesPanel />
          </div>
          <Inspector />
        </main>
        <VersionPicker />
        <DeployDialog />
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}
