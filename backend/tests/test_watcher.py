"""The watcher: polling diffs, webhooks, merge request status; and the webhook endpoint."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import Services, create_app
from foundry_studio.config import Settings
from foundry_studio.discovery import Discovery
from foundry_studio.watcher import EventBus, Watcher

from .conftest import DEPLOYS, FOUNDRY_DIR, SKYWALKER


def make_watcher(fake, foundry):
    bus = EventBus()
    w = Watcher(fake, Discovery(fake, foundry.rust_schema_names, set(foundry.schemas)), bus,
                [SKYWALKER], DEPLOYS, poll_interval=0.01)
    return w, bus, bus.subscribe()


def drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return [e for e in out if e["type"] != "watcher.status"]


@pytest.mark.anyio
async def test_new_tag_new_folder_and_removal(demo_root, fake, foundry):
    w, bus, q = make_watcher(fake, foundry)
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
    assert (t["name"], t["input"], t["output"], t["inferred"]) == ("Deduplicate", "Packets", "Packets", False)

    demo.remove(demo_root, "Deduplicate")
    await w.poll_once()
    [ev] = drain(q)
    assert ev == {"type": "transformer.removed", "id": f"{SKYWALKER}:Deduplicate", "name": "Deduplicate"}


@pytest.mark.anyio
async def test_merge_request_status_changes(demo_root, fake, foundry):
    w, bus, q = make_watcher(fake, foundry)
    await w.initial_scan()
    drain(q)
    mr = fake.create_merge_request(DEPLOYS, "deploy/SWpipeline/abc", "main", "deploy(SWpipeline)")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["type"] == "mr.updated" and ev["mr"]["iid"] == mr["iid"]
    assert ev["mr"]["pipeline"]["status"] == "running"

    fake.set_pipeline_status(DEPLOYS, mr["iid"], "success")
    await w.poll_once()
    [ev] = drain(q)
    assert ev["mr"]["pipeline"]["status"] == "success"

    fake.set_pipeline_status(DEPLOYS, mr["iid"], "failed")
    await w.handle_webhook("Pipeline Hook", {"project": {"path_with_namespace": DEPLOYS}})
    [ev] = drain(q)
    assert ev["mr"]["pipeline"]["status"] == "failed"
    assert w.status()["mode"] == "webhook+polling"


@pytest.mark.anyio
async def test_push_to_deploys_main_signals_pipelines_changed(demo_root, fake, foundry):
    w, bus, q = make_watcher(fake, foundry)
    await w.initial_scan()
    drain(q)
    repo = demo_root / DEPLOYS
    (repo / "NOTES.md").write_text("x\n")
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", "notes")
    await w.poll_once()
    assert [e["type"] for e in drain(q)] == ["pipelines.changed"]


@pytest.mark.anyio
async def test_webhook_tag_push_rescans(demo_root, fake, foundry):
    w, bus, q = make_watcher(fake, foundry)
    await w.initial_scan()
    drain(q)
    demo.tag(demo_root, "XmlToJson", "v0.5.0")
    await w.handle_webhook("Tag Push Hook", {"project": {"path_with_namespace": SKYWALKER}})
    [ev] = drain(q)
    assert ev["newVersions"] == ["XmlToJson/v0.5.0"]


@pytest.mark.anyio
async def test_poll_errors_are_reported_not_fatal(demo_root, fake, foundry):
    w, bus, q = make_watcher(fake, foundry)
    w.transformer_projects.append("nobody/missing")
    await w.initial_scan()
    assert "nobody/missing" in w.status()["errors"]
    assert len(w.transformers) == 2


def test_webhook_endpoint_checks_token(demo_root, fake, foundry, monkeypatch):
    settings = Settings(foundry_dir=FOUNDRY_DIR, workspace=demo_root / "ws")
    services = Services(settings, fake, foundry, fake_root=demo_root)
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


def test_api_load_validate_check_edge(demo_root, fake, foundry):
    settings = Settings(foundry_dir=FOUNDRY_DIR, workspace=demo_root / "ws")
    app = create_app(Services(settings, fake, foundry, fake_root=demo_root), start_watcher=False)
    with TestClient(app) as client:
        assert client.get("/api/pipelines").json()["pipelines"] == [
            {"name": "SWpipeline", "deployed": True, "draft": False}]
        loaded = client.get("/api/pipelines/SWpipeline").json()
        assert loaded["source"] == "deployed"
        graph = loaded["graph"]
        assert client.post("/api/validate", json={"graph": graph}).json()["ok"]
        r = client.post("/api/check-edge", json={"graph": graph, "source": "XmlToJson", "target": "OutputSink"})
        assert "XmlToJson emits EncodedPackets but OutputSink expects Packets" in r.json()["message"]
        saved = client.put("/api/pipelines/SWpipeline", json={"graph": graph, "layout": {"positions": {}}})
        assert saved.status_code == 200
        assert client.get("/api/pipelines/SWpipeline").json()["source"] == "draft"
        assert client.get("/api/pipelines/SWpipeline?source=deployed").json()["source"] == "deployed"
