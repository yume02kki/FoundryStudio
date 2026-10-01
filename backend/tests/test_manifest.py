"""UI graph JSON -> manifest -> graph, the catalog, and determinism of what's written."""

from __future__ import annotations

import itertools
import random

import yaml

from foundry_studio.manifest import (catalog_to_yaml, graph_to_manifest, manifest_to_graph, parse_catalog,
                                     wiring)

from .conftest import FOUNDRY_DIR

SWPIPELINE = (FOUNDRY_DIR / "PipelineManifest.yaml").read_text()
CATALOG = (FOUNDRY_DIR / "catalog.yaml").read_text()
SKYWALKER_URL = "https://gitlab.com/yume02kki/skywalker.git"


def scratch_graph(node_order=None, edge_order=None, shuffle_keys=False) -> dict:
    """SWpipeline as a user builds it: two dragged cards, three dragged datasets, four wires."""
    rnd = random.Random(42)

    def keys(d: dict) -> dict:
        items = list(d.items())
        if shuffle_keys:
            rnd.shuffle(items)
        return dict(items)

    nodes = {
        "Base64Decoder": {"id": "Base64Decoder", "kind": "transformer", "transformer": keys({
            "Repo": SKYWALKER_URL, "Path": "Base64Decoder", "IN": "EncodedPackets", "OUT": "Packets"})},
        "XmlToJson": {"id": "XmlToJson", "kind": "transformer", "transformer": keys({
            "Repo": SKYWALKER_URL, "Path": "XmlToJson/", "IN": "XmlPackets", "OUT": "EncodedPackets"})},
        **{f"dataset:{d}": {"id": f"dataset:{d}", "kind": "dataset", "dataset": d}
           for d in ("raw.xml", "SWpipeline.XmlToJson.out", "packets.decoded")},
    }
    edges = [("XmlToJson", "dataset:SWpipeline.XmlToJson.out"), ("dataset:SWpipeline.XmlToJson.out", "Base64Decoder"),
             ("Base64Decoder", "dataset:packets.decoded"), ("dataset:raw.xml", "XmlToJson")]
    return {
        "name": "SWpipeline", "catalog": "catalog.yaml", "consumerGroup": "",
        "nodes": [nodes[n] for n in (node_order or nodes)],
        "edges": [{"source": u, "target": v} for u, v in (edge_order or edges)],
        "extra": {},
    }


def test_round_trip_is_byte_identical():
    assert graph_to_manifest(manifest_to_graph(SWPIPELINE)) == SWPIPELINE
    assert catalog_to_yaml(parse_catalog(CATALOG)) == CATALOG


def test_loaded_graph_shape():
    g = manifest_to_graph(SWPIPELINE)
    assert [n["id"] for n in g["nodes"]] == [
        "XmlToJson", "Base64Decoder", "dataset:raw.xml", "dataset:SWpipeline.XmlToJson.out", "dataset:packets.decoded"]
    assert [(e["source"], e["target"]) for e in g["edges"]] == [
        ("dataset:raw.xml", "XmlToJson"), ("XmlToJson", "dataset:SWpipeline.XmlToJson.out"),
        ("dataset:SWpipeline.XmlToJson.out", "Base64Decoder"), ("Base64Decoder", "dataset:packets.decoded")]
    x = next(n for n in g["nodes"] if n["id"] == "XmlToJson")
    assert x["transformer"] == {"Repo": SKYWALKER_URL, "Path": "XmlToJson", "IN": "XmlPackets", "OUT": "EncodedPackets"}
    assert g["catalog"] == "catalog.yaml"
    assert wiring(g)["Base64Decoder"] == {"Inputs": ["SWpipeline.XmlToJson.out"], "Outputs": ["packets.decoded"]}


def test_rebuilt_from_scratch_matches_byte_for_byte():
    """Whatever order the user drags and wires in, the manifest is the same bytes."""
    g = scratch_graph()
    nodes = [n["id"] for n in g["nodes"]]
    edges = [(e["source"], e["target"]) for e in g["edges"]]
    for node_order, edge_order in itertools.islice(
        zip(itertools.permutations(nodes), itertools.cycle(itertools.permutations(edges))), 15
    ):
        assert graph_to_manifest(scratch_graph(list(node_order), list(edge_order), shuffle_keys=True)) == SWPIPELINE


def test_several_inputs_are_sorted_and_unknown_keys_survive():
    g = manifest_to_graph(SWPIPELINE + "\nOwner:\n  team: data\n")
    g["nodes"].append({"id": "dataset:a.extra", "kind": "dataset", "dataset": "a.extra"})
    g["edges"].append({"source": "dataset:a.extra", "target": "Base64Decoder"})
    out = yaml.safe_load(graph_to_manifest(g))
    assert out["Transformers"]["Base64Decoder"]["Inputs"] == ["SWpipeline.XmlToJson.out", "a.extra"]
    assert out["Owner"] == {"team": "data"}
    assert "  Base64Decoder:\n" in graph_to_manifest(g)


def test_several_outputs_are_a_list():
    g = manifest_to_graph(SWPIPELINE)
    g["nodes"].append({"id": "dataset:a.copy", "kind": "dataset", "dataset": "a.copy"})
    g["edges"].append({"source": "XmlToJson", "target": "dataset:a.copy"})
    text = graph_to_manifest(g)
    assert "    Output: [SWpipeline.XmlToJson.out, a.copy]\n" in text
    again = manifest_to_graph(text)
    assert {(e["source"], e["target"]) for e in again["edges"]} == {(e["source"], e["target"]) for e in g["edges"]}


def test_unwired_and_blank_fields():
    g = manifest_to_graph(SWPIPELINE)
    g["edges"] = [e for e in g["edges"] if e["source"] != "Base64Decoder"]
    for n in g["nodes"]:
        if n["id"] == "XmlToJson":
            n["transformer"]["Ref"] = "0123456"  # an all-digit short SHA must stay a string
            n["transformer"]["Path"] = ""
    out = yaml.safe_load(graph_to_manifest(g))
    assert "Output" not in out["Transformers"]["Base64Decoder"]
    assert out["Transformers"]["XmlToJson"]["Ref"] == "0123456" and "Path" not in out["Transformers"]["XmlToJson"]


def test_consumer_group_and_catalog_edits():
    g = manifest_to_graph(SWPIPELINE)
    g["consumerGroup"] = "swpipeline"
    assert yaml.safe_load(graph_to_manifest(g))["ConsumerGroup"] == "swpipeline"

    cat = parse_catalog(CATALOG)
    cat["datasets"]["new.topic"] = {"Schema": "Packets", "Cluster": "internal"}
    cat["clusters"]["internal"]["Brokers"] = "kafka-2:9092"
    text = catalog_to_yaml(cat)
    assert yaml.safe_load(text)["Datasets"]["new.topic"] == {"Cluster": "internal", "Schema": "Packets"}
    assert text.index("Cluster: internal\n    Schema: Packets") > 0
    assert parse_catalog(text)["clusters"]["internal"]["Brokers"] == "kafka-2:9092"
