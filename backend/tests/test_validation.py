"""Validation passthrough: the API reports exactly what `deploy.py validate` reports."""

from __future__ import annotations

import shutil
import subprocess
import sys

import pytest
import yaml

from foundry_studio.foundry import locate
from foundry_studio.manifest import manifest_to_graph
from foundry_studio.validation import Validator, stage

from .conftest import FOUNDRY_DIR

SWPIPELINE = (FOUNDRY_DIR / "PipelineManifest.yaml").read_text()
CATALOG = FOUNDRY_DIR / "catalog.yaml"


def cli_errors(graph, catalog, tmp_path) -> list[str]:
    manifest = stage(graph, catalog, tmp_path / "cli")
    res = subprocess.run([sys.executable, str(FOUNDRY_DIR / "deploy.py"), "validate", str(manifest)],
                         capture_output=True, text=True)
    return [line[len("  - "):] for line in res.stderr.splitlines() if line.startswith("  - ")]


def edit(text: str, old: str, new: str) -> str:
    assert old in text, old
    return text.replace(old, new)


CASES = {
    "type mismatch": edit(SWPIPELINE, "Inputs: [SWpipeline.XmlToJson.out]", "Inputs: [raw.xml]"),
    "output mismatch": edit(SWPIPELINE, "Output: SWpipeline.XmlToJson.out", "Output: packets.decoded"),
    "unknown dataset": edit(SWPIPELINE, "Inputs: [raw.xml]", "Inputs: [raw.json]"),
    "bad consumer group": edit(SWPIPELINE, "Inputs: [SWpipeline.XmlToJson.out]",
                             "Inputs: [SWpipeline.XmlToJson.out]\n    ConsumerGroup: bad name"),
    "cycle": edit(edit(SWPIPELINE, "Inputs: [raw.xml]", "Inputs: [packets.decoded]"),
                  "IN: XmlPackets", "IN: Packets"),
    "missing output": edit(SWPIPELINE, "    Output: packets.decoded\n", ""),
    "no catalog": edit(SWPIPELINE, "Catalog: catalog.yaml", "Catalog: nope.yaml"),
}


@pytest.mark.parametrize("case", CASES)
def test_errors_match_the_cli(case, foundry, tmp_path):
    graph = manifest_to_graph(CASES[case])
    if case == "no catalog":
        graph["catalog"] = "nope.yaml"
    catalog = CATALOG if case != "no catalog" else tmp_path / "missing.yaml"
    expected = cli_errors(graph, catalog, tmp_path)
    assert expected, "the case should be invalid"
    result = Validator(foundry).validate(graph, catalog)
    assert not result["ok"]
    assert [e["message"] for e in result["errors"]] == expected


def test_valid_pipeline_summary(foundry):
    r = Validator(foundry).validate(manifest_to_graph(SWPIPELINE), CATALOG)
    assert r["ok"] and r["summary"].startswith("SWpipeline: OK — 2 transformers, 3 datasets")
    assert (r["sources"], r["sinks"]) == (["raw.xml"], ["packets.decoded"])


def test_errors_are_located():
    assert locate("Transformers.Base64Decoder.Inputs: raw.xml carries XmlPackets but Base64Decoder expects "
                  "EncodedPackets")["edge"] == ["dataset:raw.xml", "Base64Decoder"]
    assert locate("Transformers.XmlToJson.Output: XmlToJson emits EncodedPackets but packets.decoded carries "
                  "Packets")["edge"] == ["XmlToJson", "dataset:packets.decoded"]
    assert locate("Transformers.A.Inputs: unknown dataset 'x.y'; register the topic and add it to the catalog's "
                  "Datasets")["edge"] == ["dataset:x.y", "A"]
    assert locate("Transformers.A: missing 'Repo'")["node"] == "A"
    assert locate("Transformers: cycle detected among A, B")["nodes"] == ["A", "B"]
    assert locate("Datasets.raw.xml.Cluster: unknown cluster 'x' (defined: a)")["node"] == "dataset:raw.xml"
    assert locate("Clusters.core: missing 'Brokers'")["field"] == "Clusters.core"


def test_check_edge(foundry):
    v = Validator(foundry)
    g = manifest_to_graph(SWPIPELINE)
    r = v.check_edge(g, "dataset:raw.xml", "Base64Decoder", CATALOG)
    assert r["message"] == "Transformers.Base64Decoder.Inputs: raw.xml carries XmlPackets but Base64Decoder " \
                           "expects EncodedPackets"
    # A second output is fine as long as the schema matches.
    assert "emits EncodedPackets but packets.decoded carries Packets" in \
        v.check_edge(g, "XmlToJson", "dataset:packets.decoded", CATALOG)["message"]
    assert "through a dataset" in v.check_edge(g, "XmlToJson", "Base64Decoder", CATALOG)["message"]
    g["edges"] = [e for e in g["edges"] if e["source"] != "Base64Decoder"]
    assert v.check_edge(g, "Base64Decoder", "dataset:packets.decoded", CATALOG)["ok"]


def test_catalog_validation(foundry, tmp_path):
    cat_dir = tmp_path / "ws"
    shutil.copytree(FOUNDRY_DIR / "schemas", cat_dir / "schemas")
    shutil.copyfile(CATALOG, cat_dir / "catalog.yaml")
    from foundry_studio.manifest import parse_catalog

    cat = parse_catalog(CATALOG.read_text())
    v = Validator(foundry)
    assert v.validate_catalog(cat, cat_dir / "catalog.yaml")["ok"]
    cat["datasets"]["x.y"] = {"Cluster": "nowhere", "Schema": "Packets"}
    r = v.validate_catalog(cat, cat_dir / "catalog.yaml")
    assert not r["ok"] and r["errors"][0]["node"] == "dataset:x.y"


def test_endpoint(foundry):
    from foundry_studio.manifest import parse_catalog

    cat = parse_catalog(CATALOG.read_text())
    ep = Validator(foundry).endpoint(manifest_to_graph(SWPIPELINE), "XmlToJson", cat)
    assert (ep["topic"], ep["schema"], ep["cluster"]) == ("SWpipeline.XmlToJson.out", "EncodedPackets", "internal")
    assert ep["connection"]["Brokers"] == "kafka-internal:9092"
    assert yaml.safe_load(CATALOG.read_text())["Datasets"]["raw.xml"]["Cluster"] == \
        Validator(foundry).endpoint(manifest_to_graph(SWPIPELINE), "dataset:raw.xml", cat)["cluster"]
