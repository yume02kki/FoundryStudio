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
    assert graph["configs"] == {"Repo": "https://gitlab.com/foundry-platform/common/configs.git"}
    assert graph_to_manifest(graph) == demo.MANIFEST


@pytest.mark.parametrize("seed", range(10))
def test_any_node_and_edge_order_gives_the_same_bytes(seed):
    graph = manifest_to_graph(demo.MANIFEST)
    rnd = random.Random(seed)
    shuffled = {**graph, "nodes": rnd.sample(graph["nodes"], len(graph["nodes"])),
                "edges": rnd.sample(graph["edges"], len(graph["edges"]))}
    assert graph_to_manifest(shuffled) == demo.MANIFEST


def test_graph_shape():
    graph = manifest_to_graph(demo.MANIFEST)
    datasets = {n["dataset"]: n["datasetSpec"] for n in graph["nodes"] if n["kind"] == "dataset"}
    assert datasets["ConvertedPackets"] == {"Type": "Kafka", "Config": "kafka/prod", "DataSchema": "Packets",
                                            "Topic": "enrichment.packets"}
    isp = next(n for n in graph["nodes"] if n["id"] == "Isp")
    assert isp["processor"] == {"Repo": "https://gitlab.com/foundry-platform/enrichers/IspEnricher.git"}
    assert wiring(graph)["Isp"] == {"Inputs": ["ConvertedPackets"], "Outputs": ["Output"]}


def test_canonical_form_orders_by_data_flow_and_keeps_extras():
    text = """\
Name: P
Processors:
  B: {Repo: r, Ref: v1.0.0, In: Mid, Out: Sink}
  A: {In: Src, Out: Mid, Repo: r, Path: /sub/}
DataSets:
  Unused: {Topic: u, Type: Kafka, DataSchema: S}
  Sink: {Topic: s, Type: Kafka, Config: kafka/prod, DataSchema: S, ConnectionSettings: {SecretRef: x, Brokers: b}}
  Mid: {Type: Kafka, DataSchema: S, Topic: m}
  Src: {Type: Kafka, DataSchema: S, Topic: src}
Future: 1
"""
    out = graph_to_manifest(manifest_to_graph(text))
    data = yaml.safe_load(out)
    assert list(data["DataSets"]) == ["Src", "Mid", "Sink", "Unused"]
    assert list(data["Processors"]) == ["A", "B"]
    assert data["Processors"]["A"] == {"Repo": "r", "Path": "sub", "In": "Src", "Out": "Mid"}
    assert list(data["DataSets"]["Sink"]["ConnectionSettings"]) == ["Brokers", "SecretRef"]
    assert data["Future"] == 1
    assert "Configs" not in data
    assert graph_to_manifest(manifest_to_graph(out)) == out


def test_undefined_dataset_becomes_a_node_with_a_warning():
    graph = manifest_to_graph("Name: P\nProcessors:\n  A: {Repo: r, In: Ghost, Out: Ghost2}\n")
    ghost = next(n for n in graph["nodes"] if n["id"] == "dataset:Ghost")
    assert ghost["datasetSpec"] is None
    assert graph["warnings"] == ["A uses dataset Ghost, which isn't under DataSets",
                                 "A uses dataset Ghost2, which isn't under DataSets"]
    out = yaml.safe_load(graph_to_manifest(graph))
    assert "DataSets" not in out and out["Processors"]["A"]["In"] == "Ghost"


def test_rejects_non_mapping():
    with pytest.raises(ValueError):
        manifest_to_graph("- a\n- b\n")


def test_flink_inputs_and_union_schemas_round_trip():
    text = (Path(__file__).parents[3] / "foundry-pipelines" / "PacketPipeline" / "PipelineManifest.yaml")
    raw = yaml.safe_load(text.read_text()) if text.exists() else None
    if raw is None:
        pytest.skip("needs a foundry-pipelines checkout next to FoundryStudio")
    again = yaml.safe_load(graph_to_manifest(manifest_to_graph(text.read_text())))
    assert again["Processors"]["Join"] == raw["Processors"]["Join"]
    assert again["DataSets"]["Enrichments"]["DataSchema"] == ["DecodeEnrichment", "IspEnrichment"]


def test_entry_comments_survive_a_save():
    text = demo.MANIFEST.replace("  Input:\n", "  # where packets come in\n  Input:\n", 1)
    text = text.replace("Processors:\n", "Processors:\n  # first: XML to JSON\n  # (stateless)\n", 1)
    again = graph_to_manifest(manifest_to_graph(text))
    assert "  # where packets come in\n  Input:\n" in again
    assert "  # first: XML to JSON\n  # (stateless)\n  XmlToJson:\n" in again
