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
from .pipelines import PipelineError, PipelineStore, seed
from .validation import Validator
from .watcher import EventBus, Watcher

log = logging.getLogger("foundry_studio")


class GraphBody(BaseModel):
    graph: dict
    catalog: dict | None = None  # an edited, unsaved catalog to validate against


class SaveBody(BaseModel):
    graph: dict
    layout: dict | None = None


class CatalogBody(BaseModel):
    catalog: dict


class PeekBody(BaseModel):
    graph: dict
    node: str  # a dataset node, or a transformer (the dataset it writes)


class RollbackBody(BaseModel):
    id: str


class EdgeBody(BaseModel):
    graph: dict
    source: str
    target: str
    catalog: dict | None = None


class Services:
    def __init__(self, settings: Settings, gitlab: GitLab, foundry: Foundry, fake_root: Path | None = None,
                 workspace: Path | None = None, deploy_target: Path | None = None):
        self.settings = settings
        self.gitlab = gitlab
        self.foundry = foundry
        self.fake_root = fake_root
        self.bus = EventBus()
        self.workspace = workspace or settings.workspace or REPO_ROOT / "workspace"
        self.validator = Validator(foundry)
        self.pipelines = PipelineStore(foundry, self.workspace, deploy_target or settings.deploy_target)
        self.discovery = Discovery(gitlab, foundry.rust_schema_names,
                                   lambda: set(self.pipelines.catalog()["schemas"]))
        self.peeks = asyncio.Semaphore(8)  # concurrent live feeds
        self.watcher = Watcher(gitlab, self.discovery, self.bus, settings.transformer_projects,
                               settings.poll_interval, settings.full_rescan_interval)


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
    foundry = Foundry(settings.foundry_dir)
    fake_root = None
    if settings.fake_gitlab:
        from . import demo

        # "demo" or a directory; a directory that doesn't exist yet gets fresh demo repos.
        fake_root = demo.DEFAULT_ROOT if settings.fake_gitlab == "demo" else Path(settings.fake_gitlab).resolve()
        if not fake_root.exists():
            demo.init(fake_root, settings.foundry_dir)
        gitlab: GitLab = FakeGitLab(fake_root)
        workspace = settings.workspace or demo.workspace(fake_root)
        target = settings.deploy_target or demo.target_file(fake_root)
    else:
        gitlab = HttpGitLab(settings.gitlab_url, settings.token)
        workspace, target = settings.workspace or REPO_ROOT / "workspace", settings.deploy_target
    fake_projects = ([p["path_with_namespace"] for p in FakeGitLab(fake_root).projects_sync()]
                     if fake_root else [])
    gitenv.configure(os.environ, gitlab_url=settings.gitlab_url, fake_root=fake_root, fake_projects=fake_projects)
    seed(workspace, foundry)  # a new workspace starts with foundry's example catalog and pipeline
    return Services(settings, gitlab, foundry, fake_root, workspace, target)


def create_app(services: Services | None = None, start_watcher: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc = app.state.services = services or build_services(Settings.from_env())
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
            "foundryCommit": s.foundry.commit,
            "workspace": str(s.workspace),
            "deployTarget": str(s.pipelines.target_file) if s.pipelines.target_file else None,
            "transformerProjects": s.watcher.projects_with_transformers,
            "watcher": s.watcher.status(),
        }

    @app.get("/api/catalog")
    async def catalog(request: Request):
        return svc(request).pipelines.catalog()

    @app.post("/api/catalog/validate")
    async def validate_catalog(body: CatalogBody, request: Request):
        s = svc(request)
        return await asyncio.to_thread(s.validator.validate_catalog, body.catalog, s.pipelines.catalog_path)

    @app.put("/api/catalog")
    async def save_catalog(body: CatalogBody, request: Request):
        s = svc(request)
        check = await asyncio.to_thread(s.validator.validate_catalog, body.catalog, s.pipelines.catalog_path)
        if not check["ok"]:
            raise PipelineError(422, f"catalog invalid ({len(check['errors'])} errors); not saved", check["errors"])
        return await asyncio.to_thread(s.pipelines.save_catalog, body.catalog)

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
    async def template():
        return {"name": "", "catalog": "../catalog.yaml", "consumerGroup": "", "nodes": [], "edges": [], "extra": {}}

    @app.get("/api/pipelines")
    async def list_pipelines(request: Request):
        return {"pipelines": await asyncio.to_thread(svc(request).pipelines.list)}

    @app.get("/api/pipelines/{name}")
    async def load_pipeline(name: str, request: Request):
        return await asyncio.to_thread(svc(request).pipelines.load, name)

    @app.put("/api/pipelines/{name}")
    async def save_pipeline(name: str, body: SaveBody, request: Request):
        if (body.graph.get("name") or "") != name:
            raise HTTPException(400, "pipeline name in the URL and the graph differ")
        return await asyncio.to_thread(svc(request).pipelines.save, body.graph, body.layout)

    @app.post("/api/manifest")
    async def manifest(body: GraphBody):
        return {"manifest": graph_to_manifest(body.graph)}

    @app.post("/api/validate")
    async def validate(body: GraphBody, request: Request):
        s = svc(request)
        return await asyncio.to_thread(s.validator.validate, body.graph, s.pipelines.catalog_path, body.catalog)

    @app.post("/api/check-edge")
    async def check_edge(body: EdgeBody, request: Request):
        s = svc(request)
        return await asyncio.to_thread(s.validator.check_edge, body.graph, body.source, body.target,
                                       s.pipelines.catalog_path, body.catalog)

    # -- deploys ------------------------------------------------------------------------ #

    def _operation(request: Request, work) -> StreamingResponse:
        """Server-Sent Events for a blocking deploy.py operation: log lines, then result (or error)."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def log(line: str) -> None:
            for part in str(line).splitlines() or [""]:
                loop.call_soon_threadsafe(queue.put_nowait, {"type": "log", "line": part})

        def run() -> None:
            try:
                event = {"type": "result", **work(log)}
            except PipelineError as e:
                event = {"type": "error", "status": e.status, "message": str(e), "errors": e.errors}
            except Exception as e:  # keep the stream well-formed whatever happens
                log_ = logging.getLogger("foundry_studio.deploy")
                log_.exception("deploy operation failed")
                event = {"type": "error", "status": 500, "message": str(e), "errors": []}
            loop.call_soon_threadsafe(queue.put_nowait, event)

        async def stream():
            task = asyncio.create_task(asyncio.to_thread(run))
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=10)
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
                        continue
                    yield _sse(event)
                    if event["type"] in ("result", "error"):
                        break
            finally:
                await task

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/pipelines/{name}/deploy")
    async def deploy(name: str, request: Request):
        s = svc(request)
        s.pipelines.target()  # fail fast (400) when no target is configured
        return _operation(request, lambda log: s.pipelines.deploy(name, log))

    @app.post("/api/pipelines/{name}/rollback")
    async def rollback(name: str, body: RollbackBody, request: Request):
        s = svc(request)
        s.pipelines.target()
        return _operation(request, lambda log: s.pipelines.rollback(name, body.id, log))

    @app.post("/api/pipelines/{name}/stop")
    async def stop(name: str, request: Request):
        s = svc(request)
        s.pipelines.target()
        return _operation(request, lambda log: s.pipelines.stop(name, log))

    @app.get("/api/pipelines/{name}/deploys")
    async def deploys(name: str, request: Request):
        return await asyncio.to_thread(svc(request).pipelines.history, name)

    @app.post("/api/peek")
    async def peek(body: PeekBody, request: Request):
        """Server-Sent Events: a read-only live feed of a dataset (see peek.py).

        node is a dataset node, or a transformer (the dataset it writes)."""
        s = svc(request)
        catalog = s.pipelines.catalog()
        try:
            ep = s.validator.endpoint(body.graph, body.node, catalog)
        except ValueError as e:
            raise HTTPException(400, str(e))
        topic, ontology = ep["topic"], ep["schema"]
        schema_file = (catalog.get("schemas") or {}).get(ontology) if ontology else None
        schema_path = (s.workspace / schema_file).resolve() if schema_file else None
        schema_bytes = (schema_path.read_bytes() if schema_path and schema_path.is_file()
                        and s.workspace.resolve() in schema_path.parents else None)
        checker = FormatChecker(ontology, schema_file, schema_bytes)
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
