"""UI graph JSON -> manifest -> graph, and determinism of the written manifest."""

from __future__ import annotations

import itertools
import random

import yaml

from foundry_studio.manifest import graph_to_manifest, manifest_to_graph, parse_relation

from .conftest import FOUNDRY_DIR

SWPIPELINE = (FOUNDRY_DIR / "PipelineManifest.yaml").read_text()
SKYWALKER_URL = "https://gitlab.com/yume02kki/skywalker.git"


def scratch_graph(foundry, node_order=None, edge_order=None, shuffle_keys=False) -> dict:
    """SWpipeline as a user builds it in the UI: template, name, two dragged cards, wiring, sinks."""
    ex = foundry.example_manifest
    rnd = random.Random(42)

    def keys(d: dict) -> dict:
        items = list(d.items())
        if shuffle_keys:
            rnd.shuffle(items)
        return dict(items)

    nodes = {
        "InputSink": {"id": "InputSink", "kind": "source", "sink": keys({
            "Type": "Kafka", "Topic": "raw.xml", "Ontology": "XmlPackets",
            "ConnectionSettings": keys({
                "ConsumerGroup": "swpipeline", "SecretRef": "upstream-kafka-creds", "Brokers": "upstream-kafka:9092",
                "SaslMechanism": "SCRAM-SHA-512", "SecurityProtocol": "SASL_SSL",
            }),
        })},
        "OutputSink": {"id": "OutputSink", "kind": "output", "sink": keys({
            "Type": "Kafka", "Ontology": "Packets", "Topic": "packets.decoded",
            "ConnectionSettings": keys({
                "Brokers": "downstream-kafka:9092", "SecurityProtocol": "SASL_SSL",
                "SaslMechanism": "SCRAM-SHA-512", "SecretRef": "downstream-kafka-creds",
            }),
        })},
        "Base64Decoder": {"id": "Base64Decoder", "kind": "transformer", "transformer": keys({
            "Repo": SKYWALKER_URL, "Path": "Base64Decoder", "Ref": "Base64Decoder/v0.4.2",
            "IN": "EncodedPackets", "OUT": "Packets",
        })},
        "XmlToJson": {"id": "XmlToJson", "kind": "transformer", "transformer": keys({
            "Repo": SKYWALKER_URL, "Path": "XmlToJson", "Ref": "XmlToJson/v0.4.2",
            "IN": "XmlPackets", "OUT": "EncodedPackets",
        })},
    }
    edges = [("XmlToJson", "Base64Decoder"), ("Base64Decoder", "OutputSink"), ("InputSink", "XmlToJson")]
    return {
        "name": "SWpipeline",
        "defaults": ex["Defaults"],
        "schemas": ex["Schemas"],
        "nodes": [nodes[n] for n in (node_order or nodes)],
        "edges": [{"source": u, "target": v} for u, v in (edge_order or edges)],
        "extra": {},
    }


def test_round_trip_is_byte_identical():
    graph = manifest_to_graph(SWPIPELINE)
    assert graph_to_manifest(graph) == SWPIPELINE


def test_loaded_graph_shape():
    g = manifest_to_graph(SWPIPELINE)
    assert [n["id"] for n in g["nodes"]] == ["InputSink", "OutputSink", "XmlToJson", "Base64Decoder"]
    assert [(e["source"], e["target"]) for e in g["edges"]] == [
        ("InputSink", "XmlToJson"), ("XmlToJson", "Base64Decoder"), ("Base64Decoder", "OutputSink"),
    ]
    by_id = {n["id"]: n for n in g["nodes"]}
    assert by_id["InputSink"]["sink"]["Ontology"] == "XmlPackets"
    assert by_id["OutputSink"]["sink"]["Ontology"] == "Packets"
    assert by_id["XmlToJson"]["transformer"]["OUT"] == "EncodedPackets"
    assert by_id["Base64Decoder"]["transformer"]["IN"] == "EncodedPackets"


def test_graph_manifest_graph(foundry):
    g = scratch_graph(foundry)
    again = manifest_to_graph(graph_to_manifest(g))
    assert {(e["source"], e["target"]) for e in again["edges"]} == {(e["source"], e["target"]) for e in g["edges"]}
    assert {n["id"]: n for n in again["nodes"]} == {n["id"]: n for n in g["nodes"]}
    assert again["defaults"] == g["defaults"] and again["schemas"] == g["schemas"]


def test_rebuilt_from_scratch_matches_byte_for_byte(foundry):
    """Whatever order the user drags and wires in, the manifest is the same bytes."""
    edges = [("XmlToJson", "Base64Decoder"), ("Base64Decoder", "OutputSink"), ("InputSink", "XmlToJson")]
    nodes = ["XmlToJson", "OutputSink", "Base64Decoder", "InputSink"]
    for node_order, edge_order in itertools.islice(
        zip(itertools.permutations(nodes), itertools.cycle(itertools.permutations(edges))), 12
    ):
        g = scratch_graph(foundry, list(node_order), list(edge_order), shuffle_keys=True)
        assert graph_to_manifest(g) == SWPIPELINE


def test_chains_and_unknown_keys_survive():
    text = SWPIPELINE.replace(
        "  - InputSink -> XmlToJson\n  - XmlToJson -> Base64Decoder\n  - Base64Decoder -> OutputSink\n",
        "  - InputSink -> XmlToJson -> Base64Decoder -> OutputSink\n",
    ) + "\nOwner:\n  team: data\n"
    g = manifest_to_graph(text)
    assert len(g["edges"]) == 3 and g["extra"] == {"Owner": {"team": "data"}}
    out = graph_to_manifest(g)
    assert yaml.safe_load(out)["Owner"] == {"team": "data"}
    assert parse_relation(yaml.safe_load(out)["Relation"]) == parse_relation(yaml.safe_load(text)["Relation"])


def test_blank_fields_are_omitted_and_scalars_quoted():
    g = manifest_to_graph(SWPIPELINE)
    for n in g["nodes"]:
        if n["id"] == "OutputSink":
            n["sink"]["Topic"] = ""
        if n["id"] == "XmlToJson":
            n["transformer"]["Ref"] = "0123456"  # an all-digit short SHA must stay a string
    data = yaml.safe_load(graph_to_manifest(g))
    assert "Topic" not in data["OutputSink"]
    assert data["Transformers"]["XmlToJson"]["Ref"] == "0123456"


def test_dangling_relation_is_reported():
    g = manifest_to_graph(SWPIPELINE.replace("  - Base64Decoder -> OutputSink\n", "  - Base64Decoder -> Nowhere\n"))
    assert ("Base64Decoder", "Nowhere") not in {(e["source"], e["target"]) for e in g["edges"]}
    assert g["warnings"] and "Nowhere" in g["warnings"][0]
