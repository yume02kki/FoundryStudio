"""Foundry Studio API."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import gitenv
from .config import REPO_ROOT, Settings
from .discovery import Discovery
from .fake_gitlab import FakeGitLab
from .foundry import Foundry
from .gitlab import GitLab, HttpGitLab
from .manifest import graph_to_manifest
from .peek import FormatChecker, PeekError, bind, client_config, demo_feed, kafka_feed
from .pipelines import PipelineError, PipelineStore, PipelineSync
from .sources import SourceError, Sources
from .validation import Validator, declarations
from .watcher import EventBus, Watcher

log = logging.getLogger("foundry_studio")


class GraphBody(BaseModel):
    graph: dict


class SaveBody(BaseModel):
    graph: dict
    layout: dict | None = None


class PeekBody(BaseModel):
    graph: dict
    node: str  # a dataset node, or a transform (the dataset it writes)


class EdgeBody(BaseModel):
    graph: dict
    source: str
    target: str


class Services:
    def __init__(self, settings: Settings, gitlab: GitLab, foundry: Foundry, fake_root: Path | None = None,
                 workspace: Path | None = None):
        self.settings = settings
        self.gitlab = gitlab
        self.foundry = foundry
        self.fake_root = fake_root
        self.bus = EventBus()
        self.workspace = workspace or settings.workspace or REPO_ROOT / "workspace"
        self.validator = Validator(foundry)
        self.pipelines = PipelineStore(self.workspace)
        self.sources = Sources(gitlab, settings.gitlab_url, foundry.manifest, settings.configs_repo,
                               settings.models_project)
        self.discovery = Discovery(gitlab, lambda: self.sources.schema_names)
        self.peeks = asyncio.Semaphore(8)  # concurrent live feeds
        self.watcher = Watcher(gitlab, self.discovery, self.bus, settings.transformer_projects,
                               settings.poll_interval, settings.full_rescan_interval,
                               pipelines=PipelineSync(self.workspace))

    async def context(self, graph: dict) -> dict:
        """What validating a graph needs besides the graph: profiles, schemas, transformer.yaml schemas."""
        configs = graph.get("configs") or {}
        ctx: dict = {"configs": None, "configs_error": None, "schemas": None,
                     "decls": declarations(graph, self.watcher.transformers.values())}
        try:
            ctx["configs"] = await self.sources.configs(configs.get("Repo"), configs.get("Ref"))
        except SourceError as e:
            ctx["configs_error"] = str(e)
        try:
            ctx["schemas"] = await self.sources.schemas()
        except SourceError:
            pass  # DataSchema names go unchecked rather than all flagged
        return ctx


def _sse(event: dict) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"


async def _single(event: dict):
    yield event


async def _until_disconnected(feed, request: Request, stop: asyncio.Event):
    """Relay a feed, with keep-alives, until it ends or the browser goes away."""
    nxt = asyncio.ensure_future(anext(feed, None))
    try:
        while True:
            done, _ = await asyncio.wait({nxt}, timeout=10)
            if await request.is_disconnected():
                return
            if not done:
                yield {"type": "ping"}
                continue
            event = nxt.result()
            if event is None:
                return
            yield event
            nxt = asyncio.ensure_future(anext(feed, None))
    finally:
        stop.set()
        if not nxt.done():
            try:
                await asyncio.wait_for(nxt, timeout=3)
            except (asyncio.TimeoutError, Exception):
                nxt.cancel()


def build_services(settings: Settings) -> Services:
    foundry = Foundry(settings.scripts_dir)
    fake_root = None
    if settings.fake_gitlab:
        from . import demo

        # "demo" or a directory; a directory that doesn't exist yet gets fresh demo repos.
        fake_root = demo.DEFAULT_ROOT if settings.fake_gitlab == "demo" else Path(settings.fake_gitlab).resolve()
        if not fake_root.exists():
            demo.init(fake_root)
        gitlab: GitLab = FakeGitLab(fake_root)
        workspace = settings.workspace or demo.workspace(fake_root)
    else:
        gitlab = HttpGitLab(settings.gitlab_url, settings.token)
        workspace = settings.workspace or REPO_ROOT / "workspace"
    fake_projects = ([p["path_with_namespace"] for p in FakeGitLab(fake_root).projects_sync()]
                     if fake_root else [])
    gitenv.configure(os.environ, gitlab_url=settings.gitlab_url, fake_root=fake_root, fake_projects=fake_projects)
    return Services(settings, gitlab, foundry, fake_root, workspace)


def create_app(services: Services | None = None, start_watcher: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc = app.state.services = services or build_services(Settings.from_env())
        try:
            await svc.sources.schemas()  # before discovery, so it can flag unknown schemas
        except SourceError as e:
            log.warning("can't read the schemas from %s: %s", svc.settings.models_project, e)
        if start_watcher:
            await svc.watcher.start()
        yield
        await svc.watcher.stop()
        await svc.gitlab.aclose()

    app = FastAPI(title="Foundry Studio", lifespan=lifespan)

    def svc(request: Request) -> Services:
        return request.app.state.services

    @app.exception_handler(PipelineError)
    async def pipeline_error(_: Request, e: PipelineError):
        return JSONResponse({"detail": str(e), "errors": e.errors, "log": e.log}, status_code=e.status)

    @app.get("/api/health")
    async def health(request: Request):
        s = svc(request)
        return {
            "mode": "demo" if s.fake_root else "gitlab",
            "gitlabUrl": s.settings.gitlab_url,
            "tokenConfigured": bool(s.settings.token),
            "webhookConfigured": bool(s.settings.webhook_secret),
            "scriptsCommit": s.foundry.commit,
            "workspace": str(s.workspace),
            "configsRepo": s.settings.configs_repo,
            "modelsProject": s.settings.models_project,
            "transformerProjects": s.watcher.projects_with_transformers,
            "watcher": s.watcher.status(),
        }

    @app.get("/api/catalog")
    async def catalog(request: Request, repo: str | None = None, ref: str | None = None):
        """What manifests can refer to (read-only): connection profiles and schemas."""
        s = svc(request)
        out: dict = {"profiles": {}, "schemas": {}, "configs": None, "errors": {}}
        try:
            c = await s.sources.configs(repo, ref)
            out["profiles"], out["configs"] = c["profiles"], {k: c[k] for k in ("repo", "ref", "commit")}
        except SourceError as e:
            out["errors"]["configs"] = str(e)
        try:
            out["schemas"] = {k: {f: v[f] for f in ("file", "format", "fields")} for k, v in (await s.sources.schemas()).items()}
        except SourceError as e:
            out["errors"]["schemas"] = str(e)
        return out

    @app.get("/api/transformers")
    async def transformers(request: Request):
        s = svc(request)
        try:
            await asyncio.wait_for(s.watcher.ready.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass
        return {
            "transformers": [t.to_json() for t in sorted(s.watcher.transformers.values(), key=lambda t: t.id)],
            "status": s.watcher.status(),
        }

    @app.get("/api/template")
    async def template(request: Request):
        return {"name": "", "configs": {"Repo": svc(request).settings.configs_repo}, "nodes": [], "edges": [], "extra": {}}

    @app.get("/api/pipelines")
    async def list_pipelines(request: Request):
        return {"pipelines": await asyncio.to_thread(svc(request).pipelines.list)}

    @app.get("/api/datasets")
    async def datasets(request: Request):
        return {"datasets": await asyncio.to_thread(svc(request).pipelines.datasets)}

    @app.get("/api/pipelines/{folder}")
    async def load_pipeline(folder: str, request: Request):
        return await asyncio.to_thread(svc(request).pipelines.load, folder)

    @app.put("/api/pipelines/{folder}")
    async def save_pipeline(folder: str, body: SaveBody, request: Request):
        return await asyncio.to_thread(svc(request).pipelines.save, folder, body.graph, body.layout)

    @app.post("/api/pipelines")
    async def create_pipeline(body: SaveBody, request: Request):
        """A new pipeline, in a new folder named after it."""
        return await asyncio.to_thread(svc(request).pipelines.save, None, body.graph, body.layout)

    @app.post("/api/manifest")
    async def manifest(body: GraphBody):
        return {"manifest": graph_to_manifest(body.graph)}

    @app.post("/api/validate")
    async def validate(body: GraphBody, request: Request):
        s = svc(request)
        ctx = await s.context(body.graph)
        return await asyncio.to_thread(s.validator.validate, body.graph, ctx["configs"], ctx["schemas"],
                                       ctx["decls"], ctx["configs_error"])

    @app.post("/api/check-edge")
    async def check_edge(body: EdgeBody, request: Request):
        s = svc(request)
        ctx = await s.context(body.graph)
        return await asyncio.to_thread(s.validator.check_edge, body.graph, body.source, body.target,
                                       ctx["configs"], ctx["schemas"], ctx["decls"])

    @app.post("/api/peek")
    async def peek(body: PeekBody, request: Request):
        """Server-Sent Events: a read-only live feed of a dataset (see peek.py).

        node is a dataset node, or a transformer (the dataset it writes)."""
        s = svc(request)
        ctx = await s.context(body.graph)
        try:
            ep = s.validator.endpoint(body.graph, body.node, ctx["configs"])
        except ValueError as e:
            raise HTTPException(400, str(e))
        topic, ontology = ep["topic"], ep["schema"]
        schema = (ctx["schemas"] or {}).get(ontology) if ontology else None
        checker = FormatChecker(ontology, schema["file"] if schema else None, schema["data"] if schema else None)
        info = {"endpoint": ep["endpoint"], "dataset": ep["dataset"], "topic": topic, "schema": ontology,
                "cluster": ep["cluster"]}

        stop = asyncio.Event()
        if s.fake_root:
            feed = demo_feed(ontology, topic, checker, stop)
        else:
            try:
                conn = bind(ep["connection"] or {}, s.settings.kafka_clusters)
                cfg = client_config(conn, s.settings.secrets_dir)
            except PeekError as e:
                feed = _single({"type": "status", "state": "error", "message": str(e)})
            else:
                feed = kafka_feed(cfg, topic, checker, stop)

        async def stream():
            if s.peeks.locked():
                yield _sse({"type": "status", "state": "error", "message": "too many live feeds open"})
                return
            async with s.peeks:
                try:
                    yield _sse({"type": "endpoint", **info})
                    async for event in _until_disconnected(feed, request, stop):
                        yield _sse(event)
                finally:
                    stop.set()
                    await feed.aclose()

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/webhooks/gitlab", status_code=202)
    async def webhook(request: Request):
        s = svc(request)
        secret = s.settings.webhook_secret
        if not secret:
            raise HTTPException(503, "webhooks are disabled: set GITLAB_WEBHOOK_SECRET")
        if not hmac.compare_digest(request.headers.get("X-Gitlab-Token", ""), secret):
            raise HTTPException(401, "bad X-Gitlab-Token")
        kind = request.headers.get("X-Gitlab-Event", "")
        payload = await request.json()
        asyncio.create_task(s.watcher.handle_webhook(kind, payload))
        return {"accepted": kind}

    @app.get("/api/events")
    async def events(request: Request):
        s = svc(request)

        async def stream():
            yield f"event: hello\ndata: {json.dumps({'status': s.watcher.status()})}\n\n"
            q = s.bus.subscribe()
            try:
                while not await request.is_disconnected():
                    try:
                        event = await asyncio.wait_for(q.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
                        continue
                    yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
            finally:
                s.bus.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    dist = REPO_ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404)
            f = (dist / path).resolve()
            return FileResponse(f if path and f.is_file() and dist in f.parents else dist / "index.html")

    return app


app = create_app()
