"""The watcher: every member project, polling diffs, webhooks; and the webhook endpoint."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import create_app
from foundry_studio.discovery import Discovery
from foundry_studio.watcher import EventBus, Watcher

from .conftest import DECODE, ISP, PROCESSOR_PROJECTS, XMLTOJSON

SCHEMAS = {"XmlPackets", "Packets", "EnrichedPackets"}


def make_watcher(fake, projects=None):
    bus = EventBus()
    w = Watcher(fake, Discovery(fake, lambda: SCHEMAS), bus, projects, poll_interval=0.01,
                discovery_interval=0)
    return w, bus, bus.subscribe()


def drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return [e for e in out if e["type"] != "watcher.status"]


def new_project(root, project: str, processors: dict[str, tuple[str, str]]):
    """A monorepo with one folder per processor (or none)."""
    repo = root / project
    repo.mkdir(parents=True)
    demo._git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("x\n")
    for name, (t_in, t_out) in processors.items():
        for rel, text in demo.processor_files(name, t_in, t_out).items():
            (repo / name / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / name / rel).write_text(text)
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", "init")


@pytest.mark.anyio
async def test_new_tag_new_repo_and_removal(demo_root, fake):
    w, bus, q = make_watcher(fake)  # every project
    await w.initial_scan()
    assert {e["processor"]["name"] for e in drain(q) if e["type"] == "processor.added"} == {"XmlToJson", "Decode", "Isp"}
    assert w.projects_with_processors == sorted(PROCESSOR_PROJECTS)

    await w.poll_once()
    assert drain(q) == []  # nothing changed, nothing sent

    demo.tag(demo_root, "decodingprocessor", "v1.1.0")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["type"] == "processor.updated" and ev["newVersions"] == ["v1.1.0"]
    assert ev["processor"]["latest"] == "v1.1.0"

    demo.add(demo_root, "Deduplicate", "Packets", "Packets", "Drops repeated guids")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["type"] == "processor.added"
    t = ev["processor"]
    assert (t["id"], t["input"], t["output"], t["warnings"]) == (f"{demo.ENRICHERS}/Deduplicate:", "Packets", "Packets", [])

    demo.remove(demo_root, "Deduplicate")
    await w.poll_once()
    [ev] = drain(q)
    assert ev == {"type": "processor.removed", "id": f"{demo.ENRICHERS}/Deduplicate:", "name": "Deduplicate"}


@pytest.mark.anyio
async def test_projects_without_processors_are_listed_but_not_shown(demo_root, fake):
    new_project(demo_root, "team-c/website", {})
    w, bus, q = make_watcher(fake)
    await w.initial_scan()
    drain(q)
    assert "team-c/website" in w.status()["projects"] and demo.CONFIGS in w.status()["projects"]
    assert "team-c/website" not in w.projects_with_processors

    # A processor added to a project that had none is found by its periodic rescan.
    repo = demo_root / "team-c/website"
    for rel, text in demo.processor_files("Shout", "Packets", "Packets").items():
        (repo / "Shout" / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / "Shout" / rel).write_text(text)
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-qm", "Shout")
    w.full_rescan_interval = 0
    await w.poll_once()
    assert "team-c/website:Shout" in {e["processor"]["id"] for e in drain(q) if e["type"] == "processor.added"}


@pytest.mark.anyio
async def test_webhook_tag_push_rescans(demo_root, fake):
    w, bus, q = make_watcher(fake, [XMLTOJSON])
    await w.initial_scan()
    drain(q)
    demo.tag(demo_root, "xmltojsonprocessor", "v1.2.0")
    await w.handle_webhook("Tag Push Hook", {"project": {"path_with_namespace": XMLTOJSON}})
    [ev] = drain(q)
    assert ev["newVersions"] == ["v1.2.0"]


@pytest.mark.anyio
async def test_webhook_for_an_unlisted_project_lists_again(demo_root, fake):
    w, bus, q = make_watcher(fake)
    await w.initial_scan()
    drain(q)
    new_project(demo_root, "team-e/new", {"Fresh": ("Packets", "Packets")})
    await w.handle_webhook("Push Hook", {"project": {"path_with_namespace": "team-e/new"}})
    assert [e["processor"]["id"] for e in drain(q)] == ["team-e/new:Fresh"]


@pytest.mark.anyio
async def test_poll_errors_are_reported_not_fatal(demo_root, fake):
    w, bus, q = make_watcher(fake, [DECODE, ISP, "nobody/missing"])
    await w.initial_scan()
    assert "nobody/missing" in w.status()["errors"]
    assert len(w.processors) == 2


def test_webhook_endpoint_checks_token(services, monkeypatch):
    app = create_app(services, start_watcher=False)
    body = {"project": {"path_with_namespace": DECODE}}
    with TestClient(app) as client:
        monkeypatch.delenv("GITLAB_WEBHOOK_SECRET", raising=False)
        assert client.post("/api/webhooks/gitlab", json=body).status_code == 503
        monkeypatch.setenv("GITLAB_WEBHOOK_SECRET", "s3cret")
        assert client.post("/api/webhooks/gitlab", json=body).status_code == 401
        assert client.post("/api/webhooks/gitlab", json=body, headers={"X-Gitlab-Token": "nope"}).status_code == 401
        r = client.post("/api/webhooks/gitlab", json=body,
                        headers={"X-Gitlab-Token": "s3cret", "X-Gitlab-Event": "Tag Push Hook"})
        assert r.status_code == 202 and r.json() == {"accepted": "Tag Push Hook"}
