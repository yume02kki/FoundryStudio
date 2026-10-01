"""The watcher: every member project, polling diffs, webhooks; and the webhook endpoint."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import Services, create_app
from foundry_studio.config import Settings
from foundry_studio.discovery import Discovery
from foundry_studio.watcher import EventBus, Watcher

from .conftest import FOUNDRY_DIR, SKYWALKER

SCHEMAS = {"XmlPackets", "EncodedPackets", "Packets"}


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


def new_project(root, project: str, transformers: dict[str, tuple[str, str]]):
    repo = root / project
    repo.mkdir(parents=True)
    demo._git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("x\n")
    for name, (t_in, t_out) in transformers.items():
        demo._write(repo, name, demo.transformer_files(name, t_in, t_out))
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", "init")


@pytest.mark.anyio
async def test_new_tag_new_folder_and_removal(demo_root, fake):
    w, bus, q = make_watcher(fake, [SKYWALKER])
    await w.initial_scan()
    assert {e["transformer"]["name"] for e in drain(q) if e["type"] == "transformer.added"} == {
        "XmlToJson", "Base64Decoder"}

    await w.poll_once()
    assert drain(q) == []  # nothing changed, nothing sent

    demo.tag(demo_root, "Base64Decoder", "v0.4.3")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["type"] == "transformer.updated" and ev["newVersions"] == ["Base64Decoder/v0.4.3"]
    assert ev["transformer"]["latest"] == "Base64Decoder/v0.4.3"

    demo.add(demo_root, "Deduplicate", "Packets", "Packets", "Drops repeated guids")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["type"] == "transformer.added"
    t = ev["transformer"]
    assert (t["name"], t["input"], t["output"], t["warnings"]) == ("Deduplicate", "Packets", "Packets", [])

    demo.remove(demo_root, "Deduplicate")
    await w.poll_once()
    [ev] = drain(q)
    assert ev == {"type": "transformer.removed", "id": f"{SKYWALKER}:Deduplicate", "name": "Deduplicate"}


@pytest.mark.anyio
async def test_every_member_project_is_scanned(demo_root, fake):
    new_project(demo_root, "team-b/enrichers", {"GeoTag": ("Packets", "Packets")})
    new_project(demo_root, "team-c/website", {})
    w, bus, q = make_watcher(fake)  # no fixed list: every project
    await w.initial_scan()
    assert {e["transformer"]["id"] for e in drain(q) if e["type"] == "transformer.added"} == {
        f"{SKYWALKER}:XmlToJson", f"{SKYWALKER}:Base64Decoder", "team-b/enrichers:GeoTag"}
    assert w.status()["projects"] == ["team-b/enrichers", "team-c/website", SKYWALKER]
    assert w.projects_with_transformers == ["team-b/enrichers", SKYWALKER]

    # A project created later shows up on the next listing.
    new_project(demo_root, "team-d/scorers", {"Score": ("Packets", "Packets")})
    await w.poll_once()
    assert [e["transformer"]["id"] for e in drain(q) if e["type"] == "transformer.added"] == ["team-d/scorers:Score"]

    # A transformer added to a project that had none is found by its periodic rescan.
    demo._write(demo_root / "team-c/website", "Shout", demo.transformer_files("Shout", "Packets", "Packets"))
    demo._git(demo_root / "team-c/website", "add", "-A")
    demo._git(demo_root / "team-c/website", "commit", "-qm", "Shout")
    w.full_rescan_interval = 0
    await w.poll_once()
    assert "team-c/website:Shout" in {e["transformer"]["id"] for e in drain(q) if e["type"] == "transformer.added"}


@pytest.mark.anyio
async def test_webhook_tag_push_rescans(demo_root, fake):
    w, bus, q = make_watcher(fake, [SKYWALKER])
    await w.initial_scan()
    drain(q)
    demo.tag(demo_root, "XmlToJson", "v0.5.0")
    await w.handle_webhook("Tag Push Hook", {"project": {"path_with_namespace": SKYWALKER}})
    [ev] = drain(q)
    assert ev["newVersions"] == ["XmlToJson/v0.5.0"]


@pytest.mark.anyio
async def test_webhook_for_an_unlisted_project_lists_again(demo_root, fake):
    w, bus, q = make_watcher(fake)
    await w.initial_scan()
    drain(q)
    new_project(demo_root, "team-e/new", {"Fresh": ("Packets", "Packets")})
    await w.handle_webhook("Push Hook", {"project": {"path_with_namespace": "team-e/new"}})
    assert [e["transformer"]["id"] for e in drain(q)] == ["team-e/new:Fresh"]


@pytest.mark.anyio
async def test_poll_errors_are_reported_not_fatal(demo_root, fake):
    w, bus, q = make_watcher(fake, [SKYWALKER, "nobody/missing"])
    await w.initial_scan()
    assert "nobody/missing" in w.status()["errors"]
    assert len(w.transformers) == 2


def test_webhook_endpoint_checks_token(demo_root, fake, foundry, monkeypatch):
    settings = Settings(foundry_dir=FOUNDRY_DIR)
    services = Services(settings, fake, foundry, fake_root=demo_root, workspace=demo.workspace(demo_root))
    app = create_app(services, start_watcher=False)
    body = {"project": {"path_with_namespace": SKYWALKER}}
    with TestClient(app) as client:
        monkeypatch.delenv("GITLAB_WEBHOOK_SECRET", raising=False)
        assert client.post("/api/webhooks/gitlab", json=body).status_code == 503
        monkeypatch.setenv("GITLAB_WEBHOOK_SECRET", "s3cret")
        assert client.post("/api/webhooks/gitlab", json=body).status_code == 401
        assert client.post("/api/webhooks/gitlab", json=body, headers={"X-Gitlab-Token": "nope"}).status_code == 401
        r = client.post("/api/webhooks/gitlab", json=body,
                        headers={"X-Gitlab-Token": "s3cret", "X-Gitlab-Event": "Tag Push Hook"})
        assert r.status_code == 202 and r.json() == {"accepted": "Tag Push Hook"}
