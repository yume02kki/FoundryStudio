"""Validation passthrough: the API reports exactly what `deploy.py validate` reports."""

from __future__ import annotations

import re
import subprocess
import sys

import pytest

from foundry_studio.foundry import locate
from foundry_studio.manifest import graph_to_manifest, manifest_to_graph
from foundry_studio.validation import Validator, stage

from .conftest import FOUNDRY_DIR

SWPIPELINE = (FOUNDRY_DIR / "PipelineManifest.yaml").read_text()


def schema_from_foundry(rel):
    p = FOUNDRY_DIR / rel
    return p.read_bytes() if p.is_file() else None


def cli_errors(graph, tmp_path) -> list[str]:
    manifest = stage(graph, tmp_path / "cli", schema_from_foundry)
    res = subprocess.run([sys.executable, str(FOUNDRY_DIR / "deploy.py"), "validate", str(manifest)],
                         capture_output=True, text=True)
    return [line[len("  - "):] for line in res.stderr.splitlines() if line.startswith("  - ")]


def edit(text: str, old: str, new: str) -> str:
    assert old in text, old
    return text.replace(old, new)


R = "Relation:\n  - InputSink -> XmlToJson\n  - XmlToJson -> Base64Decoder\n  - Base64Decoder -> OutputSink\n"
CASES = {
    "type mismatch": edit(SWPIPELINE, R, "Relation:\n  - InputSink -> XmlToJson -> OutputSink\n"
                                         "  - XmlToJson -> Base64Decoder\n"),
    "into InputSink / out of OutputSink / self loop": edit(
        SWPIPELINE, R, R + "  - OutputSink -> InputSink\n  - XmlToJson -> XmlToJson\n"),
    "cycle": edit(SWPIPELINE, R, R + "  - Base64Decoder -> XmlToJson\n"),
    # (Edges to unknown nodes can't exist on the canvas; see test_dangling_relation_is_reported.)
    "dangling transformer": edit(SWPIPELINE, R, "Relation:\n  - InputSink -> XmlToJson\n"),
    "feeds sink and transformer": edit(SWPIPELINE, R, R + "  - XmlToJson -> OutputSink\n"),
    "credential key": edit(SWPIPELINE, "    ConsumerGroup: swpipeline\n",
                           "    ConsumerGroup: swpipeline\n    Password: hunter2\n"),
    "unknown connection key": edit(SWPIPELINE, "    ConsumerGroup: swpipeline\n",
                                   "    ConsumerGroup: swpipeline\n    Timeout: 5\n    socket.timeout.ms: 100\n"),
    "SASL without SecretRef": edit(SWPIPELINE, "    SecretRef: downstream-kafka-creds\n", ""),
    "topic collision": edit(SWPIPELINE, "Topic: packets.decoded", "Topic: SWpipeline.XmlToJson.out"),
    "missing ontology": edit(SWPIPELINE, "  Ontology: Packets\n", ""),
}


@pytest.mark.parametrize("case", CASES)
def test_errors_match_the_cli(case, foundry, tmp_path):
    graph = manifest_to_graph(CASES[case])
    expected = cli_errors(graph, tmp_path)
    assert expected, f"{case}: deploy.py accepted it"
    result = Validator(foundry).validate(graph, schema_from_foundry)
    assert not result["ok"]
    assert [e["message"] for e in result["errors"]] == expected


def test_valid_pipeline(foundry, tmp_path):
    result = Validator(foundry).validate(manifest_to_graph(SWPIPELINE), schema_from_foundry)
    assert result["ok"] and result["errors"] == []
    assert result["internalDatasets"] == ["SWpipeline.XmlToJson.out"]
    assert result["topics"] == {
        "InputSink->XmlToJson": {"topic": "raw.xml", "internal": False},
        "XmlToJson->Base64Decoder": {"topic": "SWpipeline.XmlToJson.out", "internal": True},
        "Base64Decoder->OutputSink": {"topic": "packets.decoded", "internal": False},
    }
    assert result["manifest"] == SWPIPELINE


def test_errors_are_located(foundry):
    graph = manifest_to_graph(CASES["type mismatch"])
    errors = Validator(foundry).validate(graph, schema_from_foundry)["errors"]
    mismatch = next(e for e in errors if "type mismatch" in e["message"])
    assert mismatch["edge"] == ["XmlToJson", "OutputSink"]
    assert locate("Transformers.XmlToJson: output goes nowhere (no outgoing edge)")["node"] == "XmlToJson"
    assert locate("OutputSink.ConnectionSettings: SecurityProtocol SASL_SSL needs SecretRef") == {
        "message": "OutputSink.ConnectionSettings: SecurityProtocol SASL_SSL needs SecretRef",
        "node": "OutputSink", "edge": None, "nodes": ["OutputSink"], "field": "ConnectionSettings",
    }
    assert locate("Relation: cycle detected among Base64Decoder, XmlToJson")["nodes"] == ["Base64Decoder", "XmlToJson"]
    assert locate("Defaults.InternalDatasets.ConnectionSettings.Brokers: required")["node"] is None


def test_check_edge_uses_deploy_messages(foundry):
    g = manifest_to_graph(SWPIPELINE)
    g["edges"] = [{"source": "InputSink", "target": "XmlToJson"}]
    v = Validator(foundry)
    assert v.check_edge(g, "XmlToJson", "Base64Decoder") == {"ok": True, "message": None}
    refused = v.check_edge(g, "XmlToJson", "OutputSink")
    assert refused["message"] == (
        "Relation 'XmlToJson -> OutputSink': type mismatch — XmlToJson emits EncodedPackets but OutputSink expects Packets"
    )
    assert v.check_edge(g, "OutputSink", "XmlToJson")["message"].endswith("OutputSink cannot emit data")
    assert v.check_edge(g, "XmlToJson", "InputSink")["message"].endswith("InputSink cannot receive data")
    assert v.check_edge(g, "InputSink", "XmlToJson")["message"].endswith("duplicate edge")
    g["edges"] += [{"source": "XmlToJson", "target": "Base64Decoder"}]
    g["nodes"].append({"id": "Loop", "kind": "transformer",
                       "transformer": {"IN": "Packets", "OUT": "EncodedPackets"}})
    g["edges"] += [{"source": "Base64Decoder", "target": "Loop"}]
    assert v.check_edge(g, "Loop", "Base64Decoder")["message"].startswith("Relation: cycle detected")
    g["edges"] += [{"source": "Base64Decoder", "target": "OutputSink"}]
    assert v.check_edge(g, "XmlToJson", "OutputSink")["message"].startswith("Relation 'XmlToJson -> OutputSink': type")
    g["nodes"].append({"id": "Tee", "kind": "transformer", "transformer": {"IN": "Packets", "OUT": "Packets"}})
    assert v.check_edge(g, "Base64Decoder", "Tee")["message"].startswith(
        "Transformers.Base64Decoder: feeds both OutputSink and Loop, Tee")


def test_untyped_sink_does_not_block_wiring(foundry):
    g = manifest_to_graph(edit(SWPIPELINE, "  Ontology: Packets\n", ""))
    assert Validator(foundry).check_edge(g, "XmlToJson", "OutputSink")["ok"]


def test_validation_does_not_leak_temp_paths(foundry):
    g = manifest_to_graph(SWPIPELINE)
    g["schemas"]["Packets"] = "schemas/missing.json"
    errors = Validator(foundry).validate(g, schema_from_foundry)["errors"]
    assert [e["message"] for e in errors] == ["Schemas.Packets: file not found: schemas/missing.json"]
    assert not any(re.search(r"/tmp/|studio-validate", e["message"]) for e in errors)
    assert graph_to_manifest(g)  # still writable
