"""Validation goes through manifest.py's check(), and errors land on the node or edge they name."""

from __future__ import annotations

import copy
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import create_app
from foundry_studio.foundry import locate
from foundry_studio.manifest import graph_to_manifest, manifest_to_graph

from .conftest import SCRIPTS_DIR


@pytest.fixture
def client(services):
    with TestClient(create_app(services)) as c:
        c.get("/api/processors")  # waits for discovery
        yield c


def graph():
    return manifest_to_graph(demo.MANIFEST)


def dataset(g, name):
    return next(n for n in g["nodes"] if n["id"] == f"dataset:{name}")


def validate(client, g) -> list[dict]:
    return client.post("/api/validate", json={"graph": g}).json()["errors"]


def test_demo_pipeline_is_valid(client):
    r = client.post("/api/validate", json={"graph": graph()}).json()
    assert r["ok"] and r["errors"] == []
    assert r["summary"] == "3 processors, 3 datasets"
    assert (r["sources"], r["sinks"]) == (["Input"], ["Output"])
    assert r["manifest"] == demo.MANIFEST


def test_errors_are_located(client):
    g = graph()
    dataset(g, "Output")["datasetSpec"]["DataSchema"] = "Nope"
    dataset(g, "ConvertedPackets")["datasetSpec"]["Config"] = "kafka/missing"
    del dataset(g, "Input")["datasetSpec"]["Topic"]
    errors = {e["message"]: e for e in validate(client, g)}
    assert errors["DataSets.Output.DataSchema: unknown schema 'Nope' (known: EnrichedPackets, Packets, XmlPackets)"][
        "node"] == "dataset:Output"
    assert errors["DataSets.ConvertedPackets: Config 'kafka/missing' not found (known: kafka/load, kafka/prod)"][
        "node"] == "dataset:ConvertedPackets"
    assert errors["DataSets.Input: missing Topic"]["node"] == "dataset:Input"


def test_schema_mismatch_lands_on_the_edge(client):
    g = graph()
    g["edges"] = [e for e in g["edges"] if e["target"] != "Decode"] + [{"source": "dataset:Input", "target": "Decode"}]
    [e] = validate(client, g)
    assert e["message"] == "Processors.Decode.In: Input carries XmlPackets but Decode reads Packets"
    assert e["edge"] == ["dataset:Input", "Decode"]


def test_pinned_ref_uses_that_versions_processor_yaml(client, demo_root):
    # A new release of Decode that reads XmlPackets: pinning it makes the existing wire wrong.
    repo = demo_root / demo.ENRICHERS / "decodingprocessor"
    (repo / "processor.yaml").write_text("name: Decode\nin: XmlPackets\nout: EnrichedPackets\n")
    demo.tag(demo_root, "decodingprocessor", "v2.0.0")
    client.app.state.services.watcher.full_rescan_interval = 0
    client.portal.call(client.app.state.services.watcher.poll_once)
    g = graph()
    next(n for n in g["nodes"] if n["id"] == "Decode")["processor"]["Ref"] = "v2.0.0"
    [e] = validate(client, g)
    assert e["message"] == "Processors.Decode.In: ConvertedPackets carries Packets but Decode reads XmlPackets"
    del next(n for n in g["nodes"] if n["id"] == "Decode")["processor"]["Ref"]
    assert validate(client, g)  # the default branch has the new processor.yaml too
    next(n for n in g["nodes"] if n["id"] == "Decode")["processor"]["Ref"] = "v1.0.0"
    assert validate(client, g) == []


def test_second_input_is_reported(client):
    g = graph()
    g["edges"].append({"source": "dataset:Input", "target": "Isp"})
    messages = [e["message"] for e in validate(client, g)]
    assert "Processors.Isp.In: Isp reads ConvertedPackets and Input; a processor reads one dataset" in messages


def test_check_edge(client):
    g = graph()
    check = lambda s, t, gr=g: client.post("/api/check-edge", json={"graph": gr, "source": s, "target": t}).json()  # noqa: E731
    assert check("Decode", "Isp")["message"].endswith("processors connect through a dataset; drop a dataset between them")
    assert check("dataset:Input", "dataset:Output")["message"] == "datasets connect through a processor"
    assert check("dataset:Input", "Isp")["message"] == (
        "Processors.Isp.In: Isp already reads ConvertedPackets; a processor reads one dataset")
    unwired = {**g, "edges": [e for e in g["edges"] if e["target"] != "Isp"]}
    assert check("dataset:Input", "Isp", unwired)["message"] == (
        "Processors.Isp.In: Input carries XmlPackets but Isp reads Packets")
    assert check("dataset:ConvertedPackets", "Isp", unwired) == {"ok": True, "message": None}
    # Isp reading Output (which it writes) would be a self loop.
    assert "reads and writes Output" in check("dataset:Output", "Isp", unwired)["message"]


def test_cli_agrees(client, demo_root, tmp_path):
    """manifest.py validate (the CLI) and Studio report the same errors for the same manifest."""
    g = copy.deepcopy(graph())
    dataset(g, "Output")["datasetSpec"]["DataSchema"] = "Nope"
    g["edges"] = [e for e in g["edges"] if e["target"] != "Decode"] + [{"source": "dataset:Input", "target": "Decode"}]
    manifest = tmp_path / "PipelineManifest.yaml"
    manifest.write_text(graph_to_manifest(g))
    cli = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "manifest" / "manifest.py"), "validate", str(manifest),
         "--configs", str(demo_root / demo.CONFIGS)],
        capture_output=True, text=True)
    assert cli.returncode == 1
    cli_errors = sorted(line.removeprefix("error: ") for line in cli.stderr.splitlines())
    assert cli_errors == sorted(e["message"] for e in validate(client, g))


@pytest.mark.parametrize("message, node, edge", [
    ("Processors.A.In: no dataset 'X'", None, ["dataset:X", "A"]),
    ("Processors.A.Out: A writes P but Y carries Q", None, ["A", "dataset:Y"]),
    ("Processors.A: missing Repo", "A", None),
    ("DataSets.My.Set.DataSchema: unknown schema 'Q' (known: P)", "dataset:My.Set", None),
    ("Name: required", None, None),
])
def test_locate(message, node, edge):
    issue = locate(message)
    assert (issue["node"], issue["edge"]) == (node, edge)


def test_locate_cycle():
    assert locate("Processors: cycle among A, B")["nodes"] == ["A", "B"]
