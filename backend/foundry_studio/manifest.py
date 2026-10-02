"""UI graph <-> PipelineManifest.yaml.

The manifest format is the contract with manifest.py (foundry-platform/common/scripts), so the UI
never invents fields. On the canvas, processors and datasets are both nodes: an edge
dataset -> processor is the processor's In, processor -> dataset its Out. A processor has
exactly one of each. Every entry under DataSets is a dataset node, wired or not. Node
positions live in a separate PipelineManifest.layout.json.

The manifest is written in one canonical form: the layout and comments of the pipelines'
own manifests, processors in topological order (ties broken by name) and datasets in the
order data flows through them. Writing is therefore deterministic: rebuilding a pipeline by
hand yields the same bytes no matter in which order things were dragged and wired.
"""

from __future__ import annotations

from typing import Any

import yaml

from .foundry import DATASET, dataset_node

PROCESSOR_KEYS = ("Repo", "Ref", "Path", "In", "Out")
DATASET_KEYS = ("Type", "Config", "DataSchema", "Topic", "ConnectionSettings")
CONNECTION_KEYS = ("Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef")
TOP_LEVEL = ("Name", "Configs", "DataSets", "Processors")

HEADER = ("# yaml-language-server: $schema=https://gitlab.com/foundry-platform/common/scripts/-/jobs/artifacts/main/raw/"
          "manifest.schema.json?job=schema")
REF_COMMENT = "  # Ref: v1   # optional, defaults to main"
DATASETS_COMMENT = "# DataSchema names a schema in the Configs repo\'s schemas/ (types in the Foundry.Common.Models package)."


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


def _ordered(d: dict, known: tuple[str, ...]) -> dict:
    d = {k: v for k, v in (d or {}).items() if not _blank(v)}
    return {**{k: d[k] for k in known if k in d}, **{k: v for k, v in d.items() if k not in known}}


# --------------------------------------------------------------------------- #
# manifest -> graph
# --------------------------------------------------------------------------- #

def manifest_to_graph(text: str) -> dict:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("manifest is not a YAML mapping")
    nodes: list[dict] = []
    edges: list[dict] = []
    warnings: list[str] = []
    datasets = raw.get("DataSets") if isinstance(raw.get("DataSets"), dict) else {}
    for name, spec in datasets.items():
        nodes.append({"id": dataset_node(str(name)), "kind": "dataset", "dataset": str(name),
                      "datasetSpec": dict(spec) if isinstance(spec, dict) else {}})

    processors = raw.get("Processors") if isinstance(raw.get("Processors"), dict) else {}
    for name, spec in processors.items():
        spec = dict(spec) if isinstance(spec, dict) else {}
        ins, out = spec.pop("In", None), spec.pop("Out", None)
        nodes.append({"id": str(name), "kind": "processor", "processor": spec})
        for ds, edge in ((ins, {"source": dataset_node(str(ins)), "target": str(name)}),
                         (out, {"source": str(name), "target": dataset_node(str(out))})):
            if ds is None:
                continue
            if str(ds) not in datasets and not any(n["id"] == dataset_node(str(ds)) for n in nodes):
                # Referenced but not defined: show it, so the error has a node to point at.
                nodes.append({"id": dataset_node(str(ds)), "kind": "dataset", "dataset": str(ds), "datasetSpec": None})
                warnings.append(f"{name} uses dataset {ds}, which isn't under DataSets")
            edges.append(edge)
    configs = raw.get("Configs") if isinstance(raw.get("Configs"), dict) else {}
    return {
        "name": str(raw.get("Name") or ""),
        "configs": {k: str(v) for k, v in configs.items() if not _blank(v)},
        "nodes": nodes,
        "edges": edges,
        "extra": {k: v for k, v in raw.items() if k not in TOP_LEVEL},
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# graph -> manifest
# --------------------------------------------------------------------------- #

def wiring(graph: dict) -> dict[str, dict]:
    """Each processor's Inputs and Outputs (the datasets it reads and writes, in name order).

    The manifest allows one of each; the canvas refuses a second wire, and validation reports
    it if one gets through."""
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    out: dict[str, dict] = {n["id"]: {"Inputs": [], "Outputs": []}
                            for n in nodes.values() if n.get("kind") == "processor"}
    for e in graph.get("edges", []):
        s, t = nodes.get(e["source"]), nodes.get(e["target"])
        if not s or not t:
            continue
        if s.get("kind") == "dataset" and t.get("kind") == "processor":
            out[t["id"]]["Inputs"].append(s["dataset"])
        elif s.get("kind") == "processor" and t.get("kind") == "dataset":
            out[s["id"]]["Outputs"].append(t["dataset"])
    for w in out.values():
        w["Inputs"] = sorted(dict.fromkeys(w["Inputs"]))
        w["Outputs"] = sorted(dict.fromkeys(w["Outputs"]))
    return out


def canonical_order(wired: dict[str, dict]) -> list[str]:
    """Kahn's algorithm with name-sorted ties; processors on a cycle go last."""
    feeds = {t: {r for r, rw in wired.items() if r != t and set(wired[t]["Outputs"]) & set(rw["Inputs"])}
             for t in wired}
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
    order = canonical_order(wired)
    sections: list[list[str]] = [[HEADER, f"Name: {_scalar(graph.get('name') or '')}"]]

    configs = _ordered(graph.get("configs") or {}, ("Repo", "Ref"))
    if configs:
        sections.append(_value_lines("Configs", configs, 0) + ([] if "Ref" in configs else [REF_COMMENT]))

    # Datasets in the order data flows through them, then any that nothing reads or writes.
    names: list[str] = []
    for t in order:
        names += [d for d in wired[t]["Inputs"] + wired[t]["Outputs"] if d not in names]
    defined = {n["dataset"]: n.get("datasetSpec") for n in nodes.values() if n.get("kind") == "dataset"}
    names += sorted(d for d in defined if d not in names)
    entries = []
    for d in names:
        spec = defined.get(d)
        if spec is None:
            continue  # referenced but undefined: validation says so
        spec = dict(spec)
        if isinstance(spec.get("ConnectionSettings"), dict):
            spec["ConnectionSettings"] = _ordered(spec["ConnectionSettings"], CONNECTION_KEYS)
        spec = _ordered(spec, DATASET_KEYS)
        entries.append(_value_lines(d, spec, 2) if spec else [f"  {_key(d)}: {{}}"])
    if entries:
        lines = [DATASETS_COMMENT, "DataSets:"]
        for j, entry in enumerate(entries):
            lines += ([""] if j else []) + entry
        sections.append(lines)

    if order:
        lines = ["Processors:"]
        for j, t in enumerate(order):
            spec = {k: v for k, v in (nodes[t].get("processor") or {}).items() if k not in ("In", "Out")}
            if spec.get("Path") is not None:
                spec["Path"] = str(spec["Path"]).strip("/")
            ins, outs = wired[t]["Inputs"], wired[t]["Outputs"]
            # One of each; with several (refused by the canvas), the first is written and validation flags it.
            spec.update(In=ins[0] if ins else None, Out=outs[0] if outs else None)
            spec = _ordered(spec, PROCESSOR_KEYS)
            lines += ([""] if j else []) + (_value_lines(t, spec, 2) if spec else [f"  {_key(t)}: {{}}"])
        sections.append(lines)

    for k, v in (graph.get("extra") or {}).items():
        if k not in TOP_LEVEL:
            sections.append(_value_lines(k, v, 0))
    return "\n\n".join("\n".join(s) for s in sections) + "\n"


def is_dataset(node_id: str) -> bool:
    return node_id.startswith(DATASET)
