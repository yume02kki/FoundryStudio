"""The workspace API: pipelines, the catalog, and deploys (Runner: none) with history and rollback."""

from __future__ import annotations

import json

import pytest
import yaml
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import Services, create_app
from foundry_studio.config import Settings

from .conftest import FOUNDRY_DIR


@pytest.fixture
def client(demo_root, fake, foundry):
    services = Services(Settings(foundry_dir=FOUNDRY_DIR), fake, foundry, fake_root=demo_root,
                        workspace=demo.workspace(demo_root), deploy_target=demo.target_file(demo_root))
    with TestClient(create_app(services, start_watcher=False)) as c:
        yield c


def events(response) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_load_validate_save(client, demo_root):
    assert client.get("/api/pipelines").json()["pipelines"] == [{"name": "SWpipeline", "deploy": None}]
    loaded = client.get("/api/pipelines/SWpipeline").json()
    graph = loaded["graph"]
    assert graph["catalog"] == "../catalog.yaml"
    assert client.post("/api/validate", json={"graph": graph}).json()["ok"]
    r = client.post("/api/check-edge", json={"graph": graph, "source": "dataset:raw.xml", "target": "Base64Decoder"})
    assert "raw.xml carries XmlPackets but Base64Decoder expects EncodedPackets" in r.json()["message"]

    graph["consumerGroup"] = "sw"
    assert client.put("/api/pipelines/SWpipeline", json={"graph": graph, "layout": {"positions": {}}}).status_code == 200
    saved = (demo.workspace(demo_root) / "SWpipeline" / "manifest.yaml").read_text()
    assert yaml.safe_load(saved)["ConsumerGroup"] == "sw"
    assert (demo.workspace(demo_root) / "SWpipeline" / "SWpipeline.layout.json").is_file()
    assert client.put("/api/pipelines/Other", json={"graph": graph}).status_code == 400


def test_catalog_read_and_save(client, demo_root):
    cat = client.get("/api/catalog").json()
    assert list(cat["datasets"]) == ["raw.xml", "SWpipeline.XmlToJson.out", "packets.decoded"]
    assert cat["schemaInfo"]["Packets"]["fields"]["guid"] == "uuid"

    cat["datasets"]["bad"] = {"Cluster": "nowhere", "Schema": "Packets"}
    r = client.put("/api/catalog", json={"catalog": cat})
    assert r.status_code == 422 and r.json()["errors"][0]["node"] == "dataset:bad"

    del cat["datasets"]["bad"]
    cat["datasets"]["packets.enriched"] = {"Cluster": "downstream", "Schema": "Packets"}
    assert client.put("/api/catalog", json={"catalog": cat}).status_code == 200
    on_disk = yaml.safe_load((demo.workspace(demo_root) / "catalog.yaml").read_text())
    assert on_disk["Datasets"]["packets.enriched"] == {"Cluster": "downstream", "Schema": "Packets"}


def test_deploy_history_rollback_stop(client):
    r = client.post("/api/pipelines/SWpipeline/deploy")
    ev = events(r)
    assert any("would run: docker compose -p foundry-swpipeline" in e.get("line", "") for e in ev)
    first = ev[-1]
    assert first["type"] == "result" and first["status"] == "deployed"

    again = events(client.post("/api/pipelines/SWpipeline/deploy"))[-1]
    assert again["status"] == "unchanged" and again["id"] == first["id"]

    # A change to the pipeline is a new deploy.
    graph = client.get("/api/pipelines/SWpipeline").json()["graph"]
    graph["consumerGroup"] = "sw"
    client.put("/api/pipelines/SWpipeline", json={"graph": graph})
    second = events(client.post("/api/pipelines/SWpipeline/deploy"))[-1]
    assert second["status"] == "deployed" and second["id"] != first["id"]

    h = client.get("/api/pipelines/SWpipeline/deploys").json()
    assert [x["id"] for x in h["history"]] == [second["id"], first["id"]]
    assert h["history"][0]["transformers"]["XmlToJson"]["image"].startswith("swpipeline-xmltojson:src-")
    assert client.get("/api/pipelines").json()["pipelines"][0]["deploy"]["id"] == second["id"]

    back = events(client.post("/api/pipelines/SWpipeline/rollback", json={"id": first["id"]}))[-1]
    assert back["status"] == "rolled-back" and back["from"] == first["id"]
    stopped = events(client.post("/api/pipelines/SWpipeline/stop"))[-1]
    assert stopped["status"] == "stopped"
    assert client.get("/api/pipelines/SWpipeline/deploys").json()["current"]["action"] == "stop"


def test_deploy_reports_invalid_manifest_and_missing_target(client, demo_root, fake, foundry):
    graph = client.get("/api/pipelines/SWpipeline").json()["graph"]
    graph["edges"] = [e for e in graph["edges"] if e["target"] != "XmlToJson"]
    client.put("/api/pipelines/SWpipeline", json={"graph": graph})
    err = events(client.post("/api/pipelines/SWpipeline/deploy"))[-1]
    assert err["type"] == "error" and err["status"] == 422
    assert err["errors"][0]["node"] == "XmlToJson"

    services = Services(Settings(foundry_dir=FOUNDRY_DIR), fake, foundry, fake_root=demo_root,
                        workspace=demo.workspace(demo_root))
    with TestClient(create_app(services, start_watcher=False)) as c:
        r = c.post("/api/pipelines/SWpipeline/deploy")
        assert r.status_code == 400 and "STUDIO_DEPLOY_TARGET" in r.json()["detail"]


def test_seeded_workspace_matches_foundrys_example(demo_root):
    ws = demo.workspace(demo_root)
    assert (ws / "catalog.yaml").read_text() == (FOUNDRY_DIR / "catalog.yaml").read_text()
    manifest = (ws / "SWpipeline" / "manifest.yaml").read_text()
    assert manifest == (FOUNDRY_DIR / "PipelineManifest.yaml").read_text().replace(
        "Catalog: catalog.yaml", "Catalog: ../catalog.yaml")
