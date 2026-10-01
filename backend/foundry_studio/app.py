"""Foundry Studio API."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import tempfile
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
from .manifest import SINK, SOURCE, graph_to_manifest
from .peek import FormatChecker, PeekError, bind, client_config, demo_feed, kafka_feed
from .pipelines import PipelineError, PipelineStore
from .validation import Validator
from .watcher import EventBus, Watcher

log = logging.getLogger("foundry_studio")


class GraphBody(BaseModel):
    graph: dict


class SaveBody(BaseModel):
    graph: dict
    layout: dict | None = None


class PeekBody(BaseModel):
    graph: dict
    node: str  # InputSink | OutputSink


class EdgeBody(BaseModel):
    graph: dict
    source: str
    target: str


class Services:
    def __init__(self, settings: Settings, gitlab: GitLab, foundry: Foundry, fake_root: Path | None = None):
        self.settings = settings
        self.gitlab = gitlab
        self.foundry = foundry
        self.fake_root = fake_root
        self.bus = EventBus()
        self.discovery = Discovery(gitlab, foundry.rust_schema_names, set(foundry.schemas))
        self.validator = Validator(foundry)
        self.pipelines = PipelineStore(gitlab, foundry, settings.workspace, settings.deploys_project,
                                       settings.deploys_base)
        self.peeks = asyncio.Semaphore(8)  # concurrent live feeds
        self.watcher = Watcher(gitlab, self.discovery, self.bus, settings.transformer_projects,
                               settings.deploys_project, settings.poll_interval, settings.full_rescan_interval)


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
    else:
        gitlab = HttpGitLab(settings.gitlab_url, settings.token)
    shim_dir = Path(tempfile.mkdtemp(prefix="studio-bin-"))
    gitenv.configure(
        os.environ, gitlab_url=settings.gitlab_url, deploys_project=settings.deploys_project, shim_dir=shim_dir,
        fake_root=fake_root, fake_projects=[*settings.transformer_projects, settings.deploys_project],
    )
    return Services(settings, gitlab, foundry, fake_root)


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
            "deploysProject": s.settings.deploys_project,
            "transformerProjects": s.settings.transformer_projects,
            "watcher": s.watcher.status(),
        }

    @app.get("/api/schemas")
    async def schemas(request: Request):
        return {n: {"file": i.file, "rustType": i.rust_type} for n, i in svc(request).foundry.schemas.items()}

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
        ex = svc(request).foundry.example_manifest
        return {
            "name": "", "defaults": ex.get("Defaults") or {}, "schemas": ex.get("Schemas") or {},
            "nodes": [
                {"id": SOURCE, "kind": "source", "sink": {"Type": "Kafka", "ConnectionSettings": {}}},
                {"id": SINK, "kind": "output", "sink": {"Type": "Kafka", "ConnectionSettings": {}}},
            ],
            "edges": [], "extra": {},
        }

    @app.get("/api/pipelines")
    async def list_pipelines(request: Request):
        return {"pipelines": await svc(request).pipelines.list()}

    @app.get("/api/pipelines/{name}")
    async def load_pipeline(name: str, request: Request, source: str | None = None):
        return await svc(request).pipelines.load(name, source)

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
        resolver = s.pipelines.schema_resolver(body.graph.get("name"))
        return await asyncio.to_thread(s.validator.validate, body.graph, resolver)

    @app.post("/api/check-edge")
    async def check_edge(body: EdgeBody, request: Request):
        return svc(request).validator.check_edge(body.graph, body.source, body.target)

    @app.post("/api/deploy")
    async def deploy(body: GraphBody, request: Request):
        s = svc(request)
        if not s.fake_root and not s.settings.token:
            raise HTTPException(400, "GITLAB_TOKEN is not set; Deploy needs write_repository and api scopes")
        proj = await s.gitlab.get_project(s.settings.deploys_project)
        result = await asyncio.to_thread(s.pipelines.deploy, body.graph, proj["http_url_to_repo"])
        if result["status"] == "opened":
            await s.watcher._guard(s.settings.deploys_project, s.watcher.refresh_merge_requests(), rescan=False)
        return result

    @app.get("/api/merge-requests/latest")
    async def latest_mr(request: Request):
        return {"mr": svc(request).watcher.latest_mr}

    @app.post("/api/peek")
    async def peek(body: PeekBody, request: Request):
        """Server-Sent Events: a read-only live feed of a sink topic (see peek.py)."""
        s = svc(request)
        if body.node not in (SOURCE, SINK):
            raise HTTPException(400, "node must be InputSink or OutputSink")
        node = next((n for n in body.graph.get("nodes", []) if n.get("id") == body.node), None)
        sink = (node or {}).get("sink") or {}
        topic = str(sink.get("Topic") or "")
        if not topic:
            raise HTTPException(400, f"{body.node} has no Topic")
        ontology = sink.get("Ontology")
        schema_file = (body.graph.get("schemas") or {}).get(ontology) if ontology else None
        schema_bytes = s.pipelines.schema_resolver(body.graph.get("name"))(schema_file) if schema_file else None
        checker = FormatChecker(ontology, schema_file, schema_bytes)

        stop = asyncio.Event()
        if s.fake_root:
            feed = demo_feed(ontology, topic, checker, stop)
        else:
            try:
                conn = bind(sink.get("ConnectionSettings") or {}, s.settings.kafka_clusters)
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
