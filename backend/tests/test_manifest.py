"""Graph <-> PipelineManifest.yaml: byte-identical round trips in any drag and wire order."""

from __future__ import annotations

import random
from pathlib import Path

import pytest
import yaml

from foundry_studio import demo
from foundry_studio.manifest import graph_to_manifest, manifest_to_graph, wiring


def test_round_trip_is_byte_identical():
    graph = manifest_to_graph(demo.MANIFEST)
    assert graph["name"] == "EnrichmentPipeline"
    assert graph["configs"] == {"Repo": "https://gitlab.com/foundry-platform/common/configRegistry.git", "Ref": "main"}
    assert graph_to_manifest(graph) == demo.MANIFEST


@pytest.mark.parametrize("seed", range(10))
def test_any_node_and_edge_order_gives_the_same_bytes(seed):
    graph = manifest_to_graph(demo.MANIFEST)
    rnd = random.Random(seed)
    shuffled = {**graph, "nodes": rnd.sample(graph["nodes"], len(graph["nodes"])),
                "edges": rnd.sample(graph["edges"], len(graph["edges"])), "flow": []}
    assert graph_to_manifest(shuffled) == graph_to_manifest({**graph, "flow": []})


def test_graph_shape():
    graph = manifest_to_graph(demo.MANIFEST)
    kafkas = {n["dataset"]: n["datasetSpec"] for n in graph["nodes"] if n["kind"] == "dataset"}
    assert kafkas["ConvertedPackets"] == {"Config": "kafka/prod", "AllowedTypes": ["Packets"], "Topic": "enrichment.packets"}
    isp = next(n for n in graph["nodes"] if n["id"] == "Isp")
    assert isp["processor"] == {"Repo": "https://gitlab.com/foundry-platform/operators/IspEnricher.git", "Ref": "main"}
    assert wiring(graph)["Isp"] == {"Inputs": ["ConvertedPackets"], "Outputs": ["Output"]}


def test_canonical_form_orders_by_data_flow_and_keeps_extras():
    text = """\
Name: P
Processors:
  B: {Repo: r, Ref: v1.0.0}
  A: {Repo: r, Path: /sub/}
Kafkas:
  Unused: {Topic: u, AllowedTypes: [S]}
  Sink: {Topic: s, Config: kafka/prod, AllowedTypes: [S], ConnectionSettings: {SecretRef: x, Brokers: b}}
  Mid: {AllowedTypes: [S], Topic: m}
  Src: {AllowedTypes: [S], Topic: src}
Flow: [Mid -> B, B -> Sink, Src -> A, A -> Mid]
Future: 1
"""
    out = graph_to_manifest(manifest_to_graph(text))
    data = yaml.safe_load(out)
    assert list(data["Kafkas"]) == ["Src", "Mid", "Sink", "Unused"]
    assert list(data["Processors"]) == ["A", "B"]
    assert data["Processors"]["A"] == {"Repo": "r", "Path": "sub"}
    assert list(data["Kafkas"]["Sink"]["ConnectionSettings"]) == ["Brokers", "SecretRef"]
    assert data["Flow"] == ["Mid -> B", "B -> Sink", "Src -> A", "A -> Mid"]  # unchanged: kept as written
    assert yaml.safe_load(graph_to_manifest({**manifest_to_graph(text), "flow": []}))["Flow"] == [
        "Src -> A", "A -> Mid", "Mid -> B", "B -> Sink"]
    assert data["Future"] == 1
    assert "ConfigRegistry" not in data
    assert graph_to_manifest(manifest_to_graph(out)) == out


def test_a_changed_flow_is_rewritten_grouped_by_processor():
    graph = manifest_to_graph(demo.MANIFEST)
    graph["edges"] = [e for e in graph["edges"] if e["source"] != "Isp"]
    flow = graph_to_manifest(graph).split("Flow:\n")[1]
    assert flow == ("    - Input -> XmlToJson\n    - XmlToJson -> ConvertedPackets\n\n"
                    "    - ConvertedPackets -> Decode\n    - Decode -> Output\n\n"
                    "    - ConvertedPackets -> Isp\n")


def test_undefined_names_become_nodes_with_a_warning():
    graph = manifest_to_graph("Name: P\nProcessors:\n  A: {Repo: r}\nFlow:\n  - Ghost -> A\n  - A -> Ghost2\n")
    ghost = next(n for n in graph["nodes"] if n["id"] == "dataset:Ghost")
    assert ghost["datasetSpec"] is None
    assert graph["warnings"] == ["Flow uses Ghost, which isn't under Kafkas",
                                 "Flow uses Ghost2, which isn't under Kafkas"]
    out = yaml.safe_load(graph_to_manifest(graph))
    assert "Kafkas" not in out and out["Flow"] == ["Ghost -> A", "A -> Ghost2"]


def test_rejects_non_mapping():
    with pytest.raises(ValueError):
        manifest_to_graph("- a\n- b\n")


def test_the_real_pipeline_round_trips():
    path = Path(__file__).parents[3] / "foundry-pipelines" / "PacketPipeline" / "PipelineManifest.yaml"
    if not path.exists():
        pytest.skip("needs a pipelines checkout next to FoundryStudio")
    assert graph_to_manifest(manifest_to_graph(path.read_text())) == path.read_text()


def test_comments_survive_a_save():
    text = demo.MANIFEST.replace("  Input:\n", "  # where packets come in\n  Input: #mandatory\n", 1)
    text = text.replace("Processors:\n", "Processors:\n  # first: XML to JSON\n  # (stateless)\n", 1)
    text = text.replace("  Ref: main\n", "  Ref: main #non optional!\n", 1)
    again = graph_to_manifest(manifest_to_graph(text))
    assert again == text
