"""The workspace: one folder per pipeline; Save writes PipelineManifest.yaml and the layout."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import create_app
from foundry_studio.manifest import manifest_to_graph
from foundry_studio.pipelines import PipelineError, PipelineStore


@pytest.fixture
def client(services):
    with TestClient(create_app(services, start_watcher=False)) as c:
        yield c


def test_lists_folders_with_a_manifest(client, demo_root):
    (demo.workspace(demo_root) / "notes").mkdir()
    assert client.get("/api/pipelines").json() == {"pipelines": [{"folder": "PacketPipeline", "name": "EnrichmentPipeline"}]}


def test_load_and_save_round_trip(client, demo_root):
    loaded = client.get("/api/pipelines/PacketPipeline").json()
    assert loaded["folder"] == "PacketPipeline" and loaded["layout"] is None
    layout = {"version": 1, "positions": {"Isp": {"x": 1, "y": 2}}}
    r = client.put("/api/pipelines/PacketPipeline", json={"graph": loaded["graph"], "layout": layout}).json()
    folder = demo.workspace(demo_root) / "PacketPipeline"
    assert (folder / "PipelineManifest.yaml").read_text() == demo.MANIFEST
    assert json.loads((folder / "PipelineManifest.layout.json").read_text()) == layout
    assert r["folder"] == "PacketPipeline"


def test_renaming_keeps_the_folder(client, demo_root):
    graph = client.get("/api/pipelines/PacketPipeline").json()["graph"]
    client.put("/api/pipelines/PacketPipeline", json={"graph": {**graph, "name": "Renamed"}})
    assert client.get("/api/pipelines").json()["pipelines"] == [{"folder": "PacketPipeline", "name": "Renamed"}]


def test_new_pipeline_gets_its_own_folder(client, demo_root):
    template = client.get("/api/template").json()
    assert template["configs"] == {"Repo": "https://gitlab.com/foundry-common/configs.git"}
    r = client.post("/api/pipelines", json={"graph": {**template, "name": "Fresh"}})
    assert r.json()["folder"] == "Fresh"
    assert manifest_to_graph((demo.workspace(demo_root) / "Fresh" / "PipelineManifest.yaml").read_text())["name"] == "Fresh"
    assert client.post("/api/pipelines", json={"graph": {**template, "name": "Fresh"}}).status_code == 409
    assert client.post("/api/pipelines", json={"graph": {**template, "name": "../up"}}).status_code == 400


def test_datasets_across_the_workspace(client):
    names = {(d["folder"], d["name"], d["spec"]["Topic"]) for d in client.get("/api/datasets").json()["datasets"]}
    assert ("PacketPipeline", "Output", "packets.enriched") in names and len(names) == 3


def test_bad_names_and_missing_pipelines(tmp_path):
    store = PipelineStore(tmp_path)
    with pytest.raises(PipelineError) as e:
        store.load("../etc")
    assert e.value.status == 400
    with pytest.raises(PipelineError) as e:
        store.load("Nope")
    assert e.value.status == 404
