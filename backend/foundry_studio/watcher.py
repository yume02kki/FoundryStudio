"""Real-time watching of GitLab: webhooks when GitLab can reach us, polling otherwise.

Polling (every `poll_interval` seconds) reads each project's events API, plus
`last_activity_at` (which GitLab only refreshes about once an hour, so it's a backstop,
not the signal). A push or tag event on a transformer project triggers a rescan; the
rescan is diffed against the previous one and the differences go to the browser:

    transformer.added / transformer.updated (newVersions) / transformer.removed
    mr.updated        latest PipelineDeploys merge request and its CI status
    pipelines.changed PipelineDeploys' default branch moved
    watcher.status    mode, last poll, last error
"""

from __future__ import annotations

import asyncio
import logging
import time

from .discovery import Discovery, TransformerInfo
from .gitlab import GitLab

log = logging.getLogger("foundry_studio.watcher")


class EventBus:
    def __init__(self):
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, event: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # a stuck client misses events; it resyncs on reconnect

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    @property
    def subscribers(self) -> int:
        return len(self._subscribers)


def _mr_view(mr: dict) -> dict:
    pipeline = mr.get("head_pipeline") or {}
    return {
        "iid": mr["iid"], "title": mr.get("title"), "state": mr.get("state"), "webUrl": mr.get("web_url"),
        "sourceBranch": mr.get("source_branch"), "createdAt": mr.get("created_at"),
        "pipeline": {"status": pipeline.get("status"), "webUrl": pipeline.get("web_url")} if pipeline else None,
    }


class Watcher:
    def __init__(self, gitlab: GitLab, discovery: Discovery, bus: EventBus, transformer_projects: list[str],
                 deploys_project: str, poll_interval: float = 10.0, full_rescan_interval: float = 300.0):
        self.gitlab = gitlab
        self.discovery = discovery
        self.bus = bus
        self.transformer_projects = list(transformer_projects)
        self.deploys_project = deploys_project
        self.poll_interval = poll_interval
        self.full_rescan_interval = full_rescan_interval

        self.transformers: dict[str, TransformerInfo] = {}
        self.latest_mr: dict | None = None
        self.deploys_head: str | None = None
        self.errors: dict[str, str] = {}
        self.last_poll: float | None = None
        self.last_webhook: float | None = None
        self.ready = asyncio.Event()

        self._last_event: dict[str, int] = {}
        self._last_activity: dict[str, str] = {}
        self._last_full: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._task: asyncio.Task | None = None

    # -- lifecycle ---------------------------------------------------------------------- #

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="studio-watcher")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        await self.initial_scan()
        while True:
            await asyncio.sleep(self.poll_interval)
            try:
                await self.poll_once()
            except Exception:  # keep watching whatever happens
                log.exception("poll failed")

    async def initial_scan(self) -> None:
        for project in self.transformer_projects:
            await self._guard(project, self._prime(project), rescan=True)
        await self._guard(self.deploys_project, self._prime(self.deploys_project), rescan=False)
        await self._guard(self.deploys_project, self.refresh_merge_requests(), rescan=False)
        await self._guard(self.deploys_project, self._refresh_deploys_head(), rescan=False)
        self.ready.set()
        self._status()

    async def _guard(self, project: str, coro, rescan: bool) -> bool:
        try:
            await coro
            if rescan:
                await self.rescan(project)
            self.errors.pop(project, None)
            return True
        except Exception as e:  # network, auth, missing project...
            log.warning("%s: %s", project, e)
            self.errors[project] = str(e)
            return False

    async def _prime(self, project: str) -> None:
        events = await self.gitlab.list_events(project)
        self._last_event[project] = max((e["id"] for e in events), default=0)
        self._last_activity[project] = (await self.gitlab.get_project(project)).get("last_activity_at") or ""
        self._last_full[project] = time.monotonic()

    def _status(self) -> None:
        self.bus.publish({"type": "watcher.status", "status": self.status()})

    def status(self) -> dict:
        return {
            "mode": "webhook+polling" if self.last_webhook else "polling",
            "pollInterval": self.poll_interval,
            "lastPoll": self.last_poll,
            "lastWebhook": self.last_webhook,
            "errors": self.errors,
            "projects": self.transformer_projects,
            "ready": self.ready.is_set(),
        }

    # -- polling ------------------------------------------------------------------------ #

    async def _new_push_events(self, project: str) -> list[dict]:
        events = await self.gitlab.list_events(project)
        last = self._last_event.get(project, 0)
        fresh = [e for e in events if e["id"] > last]
        if events:
            self._last_event[project] = max(last, max(e["id"] for e in events))
        return [e for e in fresh if e.get("push_data") or "push" in (e.get("action_name") or "")]

    async def _activity_changed(self, project: str) -> bool:
        activity = (await self.gitlab.get_project(project)).get("last_activity_at") or ""
        changed = activity != self._last_activity.get(project)
        self._last_activity[project] = activity
        return changed

    async def poll_once(self) -> None:
        for project in self.transformer_projects:
            async def check(project=project):
                pushes = await self._new_push_events(project)
                activity = await self._activity_changed(project)
                stale = time.monotonic() - self._last_full.get(project, 0) > self.full_rescan_interval
                if pushes or activity or stale:
                    await self.rescan(project)
            await self._guard(project, check(), rescan=False)

        async def deploys():
            pushes = await self._new_push_events(self.deploys_project)
            if pushes or await self._activity_changed(self.deploys_project):
                await self._refresh_deploys_head()
            await self.refresh_merge_requests()
        await self._guard(self.deploys_project, deploys(), rescan=False)
        self.last_poll = time.time()
        self._status()

    # -- webhooks ----------------------------------------------------------------------- #

    async def handle_webhook(self, kind: str, payload: dict) -> None:
        self.last_webhook = time.time()
        project = ((payload.get("project") or {}).get("path_with_namespace")
                   or payload.get("project_path_with_namespace") or "")
        if project.lower() in (p.lower() for p in self.transformer_projects) and kind in ("Push Hook", "Tag Push Hook"):
            project = next(p for p in self.transformer_projects if p.lower() == project.lower())
            await self._guard(project, self.rescan(project), rescan=False)
        elif project.lower() == self.deploys_project.lower():
            if kind == "Push Hook":
                await self._guard(project, self._refresh_deploys_head(), rescan=False)
            if kind in ("Merge Request Hook", "Pipeline Hook", "Push Hook"):
                await self._guard(project, self.refresh_merge_requests(), rescan=False)
        self._status()

    # -- state changes ------------------------------------------------------------------ #

    async def rescan(self, project: str) -> None:
        lock = self._locks.setdefault(project, asyncio.Lock())
        async with lock:
            found = await self.discovery.scan_project(project)
            self._last_full[project] = time.monotonic()
            old = {k: v for k, v in self.transformers.items() if v.project == project}
            for tid, info in found.items():
                prev = old.get(tid)
                if prev is None:
                    self.bus.publish({"type": "transformer.added", "transformer": info.to_json()})
                elif info.to_json() != prev.to_json():
                    before = {v.ref for v in prev.versions}
                    self.bus.publish({
                        "type": "transformer.updated", "transformer": info.to_json(),
                        "newVersions": [v.ref for v in info.versions if v.ref not in before and v.kind == "tag"],
                    })
                self.transformers[tid] = info
            for tid in old.keys() - found.keys():
                gone = self.transformers.pop(tid)
                self.bus.publish({"type": "transformer.removed", "id": tid, "name": gone.name})

    async def refresh_merge_requests(self) -> None:
        mrs = await self.gitlab.list_merge_requests(self.deploys_project, limit=5)
        deploy_mrs = [m for m in mrs if str(m.get("source_branch", "")).startswith("deploy/")] or mrs
        if not deploy_mrs:
            return
        latest = max(deploy_mrs, key=lambda m: m["iid"])
        detail = _mr_view(await self.gitlab.get_merge_request(self.deploys_project, latest["iid"]))
        if detail != self.latest_mr:
            self.latest_mr = detail
            self.bus.publish({"type": "mr.updated", "mr": detail})

    async def _refresh_deploys_head(self) -> None:
        proj = await self.gitlab.get_project(self.deploys_project)
        head = await self.gitlab.get_commit(self.deploys_project, proj["default_branch"])
        sha = head["id"] if head else None
        if self.deploys_head is not None and sha != self.deploys_head:
            self.bus.publish({"type": "pipelines.changed", "head": sha})
        self.deploys_head = sha
