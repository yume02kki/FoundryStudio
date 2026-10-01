"""UI graph <-> pipeline manifest, and the catalog <-> catalog.yaml.

The manifest format is the contract with deploy.py, so the UI never invents fields. On
the canvas, transformers and datasets are both nodes: an edge dataset -> transformer is
one of the transformer's Inputs, and transformer -> dataset is its Output. Node positions
live in a separate `<Name>.layout.json`.

Both files are written in one canonical form, the section order, comments and
indentation of foundry's PipelineManifest.yaml and catalog.yaml, with transformers in
topological order (ties broken by name, the way deploy.py orders them). Writing is
therefore deterministic: rebuilding a pipeline by hand yields the same bytes no matter in
which order things were dragged and wired.
"""

from __future__ import annotations

from typing import Any

import yaml

from .foundry import DATASET, dataset_node

TRANSFORMER_KEYS = ("Repo", "Path", "Ref", "IN", "OUT", "Inputs", "Output", "ConsumerGroup")
CLUSTER_KEYS = ("Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef")
DATASET_KEYS = ("Cluster", "Schema", "Description")
TOP_LEVEL = ("Name", "Catalog", "ConsumerGroup", "Transformers")

CATALOG_COMMENT = "# The shared catalog of clusters, schemas and registered topics (datasets)."
TRANSFORMERS_COMMENT = """\
# Each transformer reads one or more datasets and writes one or more. IN/OUT are its schemas
# (transformer.yaml's in/out); they must match the datasets it's wired to.
# Consumer groups are <ConsumerGroup or Name>.<transformer>."""

CATALOG_HEADER = """\
# The shared catalog: every Kafka cluster and registered topic pipelines may use.
# Topics are registered on their cluster by hand; deploy.py only checks they exist and
# never creates, alters or deletes one. A dataset's name is the topic's real name."""
CLUSTERS_COMMENT = """\
# How to reach each cluster. Credentials never go here: SecretRef names a secret,
# read from FOUNDRY_SECRETS_DIR/<SecretRef>/username and /password."""
DATASETS_COMMENT = "# Registered topics: the cluster each lives on and the schema it carries."


# --------------------------------------------------------------------------- #
# YAML helpers
# --------------------------------------------------------------------------- #

def _blank(v: Any) -> bool:
    return v is None or v == "" or v == {} or v == []


def _scalar(v: Any) -> str:
    text = yaml.safe_dump(v, default_flow_style=True, width=1 << 30, allow_unicode=True)
    if text.endswith("\n...\n"):
        text = text[: -len("\n...\n")]
    return text.rstrip("\n")


def _key(k: Any) -> str:
    return _scalar(str(k))


def _value_lines(key: str, value: Any, indent: int) -> list[str]:
    pad = " " * indent
    if isinstance(value, dict):
        if not value:
            return [f"{pad}{_key(key)}: {{}}"]
        lines = [f"{pad}{_key(key)}:"]
        for k, v in value.items():
            lines += _value_lines(k, v, indent + 2)
        return lines
    if isinstance(value, list):
        if all(not isinstance(i, (dict, list)) for i in value):
            return [f"{pad}{_key(key)}: [{', '.join(_scalar(i) for i in value)}]"]
        lines = [f"{pad}{_key(key)}:"]
        for item in value:
            dumped = yaml.safe_dump(item, sort_keys=False, default_flow_style=False, allow_unicode=True)
            first, *rest = dumped.rstrip("\n").splitlines()
            lines.append(f"{pad}  - {first}")
            lines += [f"{pad}    {r}" for r in rest]
        return lines
    return [f"{pad}{_key(key)}: {_scalar(value)}"]


def _ordered(d: dict, known: tuple[str, ...]) -> list[tuple[str, Any]]:
    d = {k: v for k, v in (d or {}).items() if not _blank(v)}
    return [(k, d[k]) for k in known if k in d] + [(k, v) for k, v in d.items() if k not in known]


# --------------------------------------------------------------------------- #
# manifest -> graph
# --------------------------------------------------------------------------- #

def _inputs(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value] if isinstance(value, list) else []


def manifest_to_graph(text: str) -> dict:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("manifest is not a YAML mapping")
    nodes: list[dict] = []
    edges: list[dict] = []
    datasets: list[str] = []

    def use(ds: str) -> str:
        if ds not in datasets:
            datasets.append(ds)
        return dataset_node(ds)

    for name, spec in (raw.get("Transformers") or {}).items():
        spec = dict(spec or {}) if isinstance(spec, dict) else {}
        inputs, outputs = _inputs(spec.pop("Inputs", None)), _inputs(spec.pop("Output", None))
        nodes.append({"id": str(name), "kind": "transformer", "transformer": spec})
        for ds in dict.fromkeys(inputs):
            edges.append({"source": use(ds), "target": str(name)})
        for ds in dict.fromkeys(outputs):
            edges.append({"source": str(name), "target": use(ds)})
    nodes += [{"id": dataset_node(d), "kind": "dataset", "dataset": d} for d in datasets]
    return {
        "name": str(raw.get("Name") or ""),
        "catalog": str(raw.get("Catalog") or ""),
        "consumerGroup": str(raw["ConsumerGroup"]) if raw.get("ConsumerGroup") else "",
        "nodes": nodes,
        "edges": edges,
        "extra": {k: v for k, v in raw.items() if k not in TOP_LEVEL},
        "warnings": [],
    }


# --------------------------------------------------------------------------- #
# graph -> manifest
# --------------------------------------------------------------------------- #

def wiring(graph: dict) -> dict[str, dict]:
    """Each transformer's Inputs and Outputs (the datasets it reads and writes, in name order)."""
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    out: dict[str, dict] = {n["id"]: {"Inputs": [], "Outputs": []}
                            for n in nodes.values() if n.get("kind") == "transformer"}
    for e in graph.get("edges", []):
        s, t = nodes.get(e["source"]), nodes.get(e["target"])
        if not s or not t:
            continue
        if s.get("kind") == "dataset" and t.get("kind") == "transformer":
            out[t["id"]]["Inputs"].append(s["dataset"])
        elif s.get("kind") == "transformer" and t.get("kind") == "dataset":
            out[s["id"]]["Outputs"].append(t["dataset"])
    for w in out.values():
        w["Inputs"] = sorted(dict.fromkeys(w["Inputs"]))
        w["Outputs"] = sorted(dict.fromkeys(w["Outputs"]))
    return out


def canonical_order(wired: dict[str, dict]) -> list[str]:
    """Kahn's algorithm with name-sorted ties (deploy.py's ordering); transformers on a cycle go last."""
    feeds = {t: {r for r, rw in wired.items() if set(wired[t]["Outputs"]) & set(rw["Inputs"])} for t in wired}
    indeg = {t: 0 for t in wired}
    for rs in feeds.values():
        for r in rs:
            indeg[r] += 1
    ready, order = sorted(t for t, d in indeg.items() if d == 0), []
    while ready:
        t = ready.pop(0)
        order.append(t)
        for r in sorted(feeds[t]):
            indeg[r] -= 1
            if indeg[r] == 0:
                ready.append(r)
        ready.sort()
    return order + sorted(t for t in wired if t not in order)


def graph_to_manifest(graph: dict) -> str:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    wired = wiring(graph)
    sections: list[list[str]] = [[f"Name: {_scalar(graph.get('name') or '')}"]]
    if graph.get("catalog"):
        sections.append([CATALOG_COMMENT, f"Catalog: {_scalar(graph['catalog'])}"])
    if graph.get("consumerGroup"):
        sections.append([f"ConsumerGroup: {_scalar(graph['consumerGroup'])}"])

    order = canonical_order(wired)
    if order:
        lines = TRANSFORMERS_COMMENT.splitlines() + ["Transformers:"]
        for j, t in enumerate(order):
            if j:
                lines.append("")
            spec = {k: v for k, v in (nodes[t].get("transformer") or {}).items() if k not in ("Inputs", "Output")}
            if "Path" in spec and spec["Path"] is not None:
                spec["Path"] = str(spec["Path"]).strip("/")
            outputs = wired[t]["Outputs"]
            # One output is written as a plain name (the common case), several as a list.
            spec.update(Inputs=wired[t]["Inputs"], Output=outputs[0] if len(outputs) == 1 else outputs)
            spec = dict(_ordered(spec, TRANSFORMER_KEYS))
            lines += _value_lines(t, spec, 2) if spec else [f"  {_key(t)}: {{}}"]
        sections.append(lines)

    for k, v in (graph.get("extra") or {}).items():
        if k not in TOP_LEVEL:
            sections.append(_value_lines(k, v, 0))
    return "\n\n".join("\n".join(s) for s in sections) + "\n"


# --------------------------------------------------------------------------- #
# catalog
# --------------------------------------------------------------------------- #

def parse_catalog(text: str) -> dict:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("catalog is not a YAML mapping")

    def mapping(v) -> dict:
        return {str(k): (dict(x) if isinstance(x, dict) else x) for k, x in (v or {}).items()} if isinstance(v, dict) else {}

    return {
        "clusters": {k: {str(a): b for a, b in (v or {}).items()} for k, v in mapping(raw.get("Clusters")).items()},
        "schemas": {k: str(v) for k, v in mapping(raw.get("Schemas")).items()},
        "datasets": {k: dict(v or {}) for k, v in mapping(raw.get("Datasets")).items()},
        "extra": {k: v for k, v in raw.items() if k not in ("Clusters", "Schemas", "Datasets")},
    }


def catalog_to_yaml(catalog: dict) -> str:
    sections: list[list[str]] = [CATALOG_HEADER.splitlines()]
    clusters = catalog.get("clusters") or {}
    lines = CLUSTERS_COMMENT.splitlines() + (["Clusters:"] if clusters else ["Clusters: {}"])
    for name, settings in clusters.items():
        lines += _value_lines(name, dict(_ordered(settings or {}, CLUSTER_KEYS)), 2)
    sections.append(lines)
    sections.append(_value_lines("Schemas", dict(catalog.get("schemas") or {}), 0))
    datasets = catalog.get("datasets") or {}
    lines = DATASETS_COMMENT.splitlines() + (["Datasets:"] if datasets else ["Datasets: {}"])
    for name, spec in datasets.items():
        lines += _value_lines(name, dict(_ordered(spec or {}, DATASET_KEYS)), 2)
    sections.append(lines)
    for k, v in (catalog.get("extra") or {}).items():
        sections.append(_value_lines(k, v, 0))
    return "\n\n".join("\n".join(s) for s in sections) + "\n"


def is_dataset(node_id: str) -> bool:
    return node_id.startswith(DATASET)
