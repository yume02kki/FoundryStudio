"""Real-time watching of GitLab: webhooks when GitLab can reach us, polling otherwise.

Which projects: every project the token's user is a member of (re-listed every
`discovery_interval` seconds, so new projects show up on their own), or a fixed list
(STUDIO_PROCESSOR_PROJECTS). Any folder with an operator.yaml in any of them is a
processor. The pipelines repo (one folder per pipeline) is watched too, and the workspace,
a checkout of it, follows its pushes (PipelineSync).

Polling (every `poll_interval` seconds) reads each project's events API, plus
`last_activity_at` (which GitLab only refreshes about once an hour, so it's a backstop,
not the signal). A push or tag event on a processor project triggers a rescan; the
rescan is diffed against the previous one and the differences go to the browser:

    processor.added / processor.updated (newVersions) / processor.removed
    watcher.status    mode, last poll, last error
"""

from __future__ import annotations

import asyncio
import logging
import time

from .discovery import Discovery, ProcessorInfo
from .gitlab import GitLab
from .pipelines import PipelineSync

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


class Watcher:
    def __init__(self, gitlab: GitLab, discovery: Discovery, bus: EventBus, processor_projects: list[str] | None,
                 poll_interval: float = 10.0, full_rescan_interval: float = 300.0, discovery_interval: float = 60.0,
                 pipelines: PipelineSync | None = None):
        self.gitlab = gitlab
        self.pipelines = pipelines
        self.discovery = discovery
        self.bus = bus
        # None: every project the user is a member of.
        self.fixed_projects = list(processor_projects) if processor_projects else None
        if self.fixed_projects is not None and pipelines and pipelines.project not in self.fixed_projects:
            self.fixed_projects.append(pipelines.project)
        self.processor_projects = list(self.fixed_projects or [])
        self.poll_interval = poll_interval
        self.full_rescan_interval = full_rescan_interval
        self.discovery_interval = discovery_interval
        self._last_listing: float | None = None
        self._gate = asyncio.Semaphore(6)  # projects scanned at once
        self._listed_activity: dict[str, str] = {}

        self.processors: dict[str, ProcessorInfo] = {}
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
        if self.fixed_projects is None:
            await self.refresh_projects(scan=False)
        await asyncio.gather(*(self._guard(p, self._prime(p), rescan=True) for p in self.processor_projects))
        self.ready.set()
        self._status()

    @property
    def projects_with_processors(self) -> list[str]:
        return sorted({t.project for t in self.processors.values()})

    async def refresh_projects(self, scan: bool = True) -> None:
        """Every member project: scan new ones, rescan ones with new activity, forget deleted ones."""
        try:
            listed = await self.gitlab.list_projects()
            self.errors.pop("projects", None)
        except Exception as e:
            log.warning("listing projects: %s", e)
            self.errors["projects"] = str(e)
            return
        self._last_listing = time.monotonic()
        activity = {p["path_with_namespace"]: p.get("last_activity_at") or "" for p in listed}
        if self.pipelines:
            activity.setdefault(self.pipelines.project, "")
        new = [p for p in activity if p not in self.processor_projects]
        changed = [p for p in activity if p in self.processor_projects
                   and activity[p] != self._listed_activity.get(p)]
        gone = [p for p in self.processor_projects if p not in activity]
        self.processor_projects = sorted(activity)
        self._listed_activity = activity
        for project in gone:
            self._forget(project)
        if scan:
            await asyncio.gather(*(self._guard(p, self._prime(p), rescan=True) for p in new),
                                 *(self._guard(p, self.rescan(p), rescan=False) for p in changed))

    def _forget(self, project: str) -> None:
        for tid in [k for k, v in self.processors.items() if v.project == project]:
            gone = self.processors.pop(tid)
            self.bus.publish({"type": "processor.removed", "id": tid, "name": gone.name})
        for d in (self._last_event, self._last_activity, self._last_full, self.errors):
            d.pop(project, None)

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
        async with self._gate:
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
            "errors": {**self.errors, **(self.pipelines.errors if self.pipelines else {})},
            "projects": self.processor_projects,
            "scope": "fixed" if self.fixed_projects is not None else "membership",
            "withProcessors": self.projects_with_processors,
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
        auto = self.fixed_projects is None
        if auto and (self._last_listing is None or time.monotonic() - self._last_listing >= self.discovery_interval):
            await self.refresh_projects()
        with_processors = set(self.projects_with_processors) | ({self.pipelines.project} if self.pipelines else set())
        for project in self.processor_projects:
            async def check(project=project):
                stale = time.monotonic() - self._last_full.get(project, 0) > self.full_rescan_interval
                # With every member project watched, only those with processors or a pipeline are polled for
                # pushes; the others are caught by the project listing's activity and the periodic rescan.
                if auto and project not in with_processors:
                    if stale:
                        await self.rescan(project)
                    return
                pushes = await self._new_push_events(project)
                activity = await self._activity_changed(project)
                if pushes or activity or stale:
                    await self.rescan(project)
            await self._guard(project, check(), rescan=False)
        self.last_poll = time.time()
        self._status()

    # -- webhooks ----------------------------------------------------------------------- #

    async def handle_webhook(self, kind: str, payload: dict) -> None:
        self.last_webhook = time.time()
        project = ((payload.get("project") or {}).get("path_with_namespace")
                   or payload.get("project_path_with_namespace") or "")
        known = next((p for p in self.processor_projects if p.lower() == project.lower()), None)
        if kind in ("Push Hook", "Tag Push Hook") and project:
            if known:
                await self._guard(known, self.rescan(known), rescan=False)
            elif self.fixed_projects is None:
                # A group or system hook for a project we haven't listed yet: it's new.
                await self.refresh_projects()
        self._status()

    # -- state changes ------------------------------------------------------------------ #

    async def rescan(self, project: str) -> None:
        lock = self._locks.setdefault(project, asyncio.Lock())
        async with lock, self._gate:
            found = await self.discovery.scan_project(project)
            self._last_full[project] = time.monotonic()
            old = {k: v for k, v in self.processors.items() if v.project == project}
            for tid, info in found.items():
                prev = old.get(tid)
                if prev is None:
                    self.bus.publish({"type": "processor.added", "processor": info.to_json()})
                elif info.to_json() != prev.to_json():
                    before = {v.ref for v in prev.versions}
                    self.bus.publish({
                        "type": "processor.updated", "processor": info.to_json(),
                        "newVersions": [v.ref for v in info.versions if v.ref not in before and v.kind == "tag"],
                    })
                self.processors[tid] = info
            for tid in old.keys() - found.keys():
                gone = self.processors.pop(tid)
                self.bus.publish({"type": "processor.removed", "id": tid, "name": gone.name})
        if self.pipelines and project == self.pipelines.project and await self.pipelines.sync():
            self.bus.publish({"type": "pipelines.changed", "project": project})
