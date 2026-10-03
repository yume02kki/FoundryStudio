"""Validation goes through scripts' validators, and errors land on the node or edge they name."""

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


def kafka(g, name):
    return next(n for n in g["nodes"] if n["id"] == f"dataset:{name}")


def validate(client, g) -> list[dict]:
    return client.post("/api/validate", json={"graph": g}).json()["errors"]


def rewire(g, drop_target, source, target):
    g["edges"] = [e for e in g["edges"] if e["target"] != drop_target] + [{"source": source, "target": target}]
    g["flow"] = []
    return g


def test_demo_pipeline_is_valid(client):
    r = client.post("/api/validate", json={"graph": graph()}).json()
    assert r["ok"] and r["errors"] == []
    assert r["summary"] == "3 processors, 3 Kafkas"
    assert (r["sources"], r["sinks"]) == (["Input"], ["Output"])
    assert r["manifest"] == demo.MANIFEST


def test_errors_are_located(client):
    g = graph()
    kafka(g, "Output")["datasetSpec"]["AllowedTypes"] = ["Nope"]
    kafka(g, "ConvertedPackets")["datasetSpec"]["Config"] = "kafka/missing"
    del kafka(g, "Input")["datasetSpec"]["Topic"]
    errors = {e["message"]: e for e in validate(client, g)}
    assert errors["Kafkas.Output.AllowedTypes: unknown type 'Nope' (known: DecodeEnrichment, EnrichedPackets, "
                  "IspEnrichment, Packets, XmlPackets)"]["node"] == "dataset:Output"
    assert errors["Kafkas.ConvertedPackets.Config: Config 'kafka/missing' not found (known: kafka/load, kafka/prod)"][
        "node"] == "dataset:ConvertedPackets"
    assert errors["Kafkas.Input: missing Topic"]["node"] == "dataset:Input"


def test_type_mismatch_lands_on_the_edge(client):
    errors = {e["message"]: e for e in validate(client, rewire(graph(), "Decode", "dataset:Input", "Decode"))}
    assert errors["Flow: Input -> Decode: Input allows XmlPackets but Decode reads Packets"]["edge"] == ["dataset:Input", "Decode"]
    assert errors["Decode: reads Packets but none of Input allows it"]["node"] == "Decode"


def test_pinned_ref_uses_that_versions_processor_yaml(client, demo_root):
    # A new release of Decode that reads XmlPackets: pinning it makes the existing wire wrong.
    repo = demo_root / demo.OPERATORS / "decodingprocessor"
    (repo / "processor.yaml").write_text("name: Decode\ndescription: d\nRuntime: dotnet\nin: [XmlPackets]\nout: [EnrichedPackets]\n")
    demo.tag(demo_root, "decodingprocessor", "v2.0.0")
    client.app.state.services.watcher.full_rescan_interval = 0
    client.portal.call(client.app.state.services.watcher.poll_once)
    g = graph()
    decode = next(n for n in g["nodes"] if n["id"] == "Decode")["processor"]
    decode["Ref"] = "v2.0.0"
    messages = [e["message"] for e in validate(client, g)]
    assert "Flow: ConvertedPackets -> Decode: ConvertedPackets allows Packets but Decode reads XmlPackets" in messages
    decode["Ref"] = "main"
    assert validate(client, g)  # the default branch has the new processor.yaml too
    decode["Ref"] = "v1.0.0"
    assert validate(client, g) == []


def test_second_input_of_a_dotnet_processor_is_reported(client):
    g = graph()
    g["edges"].append({"source": "dataset:Input", "target": "Isp"})
    errors = {e["message"]: e for e in validate(client, g)}
    assert errors["Isp: a dotnet processor reads one Kafka, not ConvertedPackets, Input"]["node"] == "Isp"


def test_check_edge(client):
    g = graph()
    check = lambda s, t, gr=g: client.post("/api/check-edge", json={"graph": gr, "source": s, "target": t}).json()  # noqa: E731
    assert check("Decode", "Isp")["message"].endswith("processors connect through a Kafka; drop a Kafka between them")
    assert check("dataset:Input", "dataset:Output")["message"] == "Kafkas connect through a processor"
    assert check("dataset:Input", "Isp")["message"] == "Isp: already reads ConvertedPackets; a dotnet processor reads one Kafka"
    unwired = {**g, "edges": [e for e in g["edges"] if e["target"] != "Isp"], "flow": []}
    assert check("dataset:Input", "Isp", unwired)["message"] == "Flow: Input -> Isp: Input allows XmlPackets but Isp reads Packets"
    assert check("dataset:ConvertedPackets", "Isp", unwired) == {"ok": True, "message": None}
    assert any(e["message"].startswith("Flow has a cycle") for e in check("dataset:Output", "Isp", unwired)["errors"])


def test_ci_validators_agree(client, demo_root, tmp_path):
    """The pipelines CI's typecheck.py and Studio report the same type errors for the same manifest."""
    g = copy.deepcopy(graph())
    kafka(g, "Output")["datasetSpec"]["AllowedTypes"] = ["Nope"]
    rewire(g, "Decode", "dataset:Input", "Decode")
    manifest = tmp_path / "PipelineManifest.yaml"
    manifest.write_text(graph_to_manifest(g))
    env = {**__import__("os").environ}
    cli = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "validators" / "pipelines" / "typecheck.py"), str(manifest),
         "--models", str(demo_root / demo.MODELS)],
        capture_output=True, text=True, env=env)
    assert cli.returncode == 1
    cli_errors = sorted(line.removeprefix(f"error: {manifest}: ") for line in cli.stdout.splitlines())
    assert cli_errors == sorted(e["message"] for e in validate(client, g))


@pytest.mark.parametrize("message, node, edge", [
    ("Flow: X -> A: X allows P but A reads Q", None, ["dataset:X", "A"]),
    ("Flow: A -> Y: A writes P but Y allows Q", None, ["A", "dataset:Y"]),
    ("Processors.A: missing Repo", "A", None),
    ("Kafkas.My.AllowedTypes: unknown type 'Q' (known: P)", "dataset:My", None),
    ("A: reads no Kafka", "A", None),
    ("X: not in Flow", "dataset:X", None),
    ("Name: required", None, None),
])
def test_locate(message, node, edge):
    issue = locate(message, kafkas={"X", "Y", "My"}, processors={"A"})
    assert (issue["node"], issue["edge"]) == (node, edge)


def test_locate_cycle():
    assert locate("Flow has a cycle: A -> X -> A", kafkas={"X"}, processors={"A"})["nodes"] == ["A", "dataset:X"]
