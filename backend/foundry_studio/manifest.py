"""UI graph <-> PipelineManifest.yaml.

The manifest format is the contract with deploy.py, so the UI never invents fields:
the graph is the manifest's own sections plus nodes/edges for Transformers and
Relation. Node positions live in a separate `<Name>.layout.json`.

Manifests are written in one canonical form: the section order, comments and
indentation of foundry's PipelineManifest.yaml, transformers and edges in topological
order (ties broken by name, the way deploy.py orders the graph) and connection keys in
the order the runtime documents them. Writing is therefore deterministic: rebuilding a
pipeline by hand yields the same bytes no matter in which order things were dragged and
wired, and so does deploy.py's render of it.
"""

from __future__ import annotations

from typing import Any

import yaml

SOURCE = "InputSink"
SINK = "OutputSink"
SINK_KEYS = ("Type", "Ontology", "Topic", "ConnectionSettings")
TRANSFORMER_KEYS = ("Repo", "Path", "Ref", "IN", "OUT")
INTERNAL_KEYS = ("Partitions", "ReplicationFactor", "RetentionMs", "ConnectionSettings")
CONNECTION_KEYS = ("Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef", "ConsumerGroup")
TOP_LEVEL = ("Name", "Defaults", "Schemas", SOURCE, SINK, "Transformers", "Relation")

REGISTRY_COMMENT = "# Must be the PipelineDeploys container registry: its CI builds and pushes these images."
INTERNAL_COMMENT = """\
# Internal datasets are the topics between transformers. They're generated
# from Relation and owned by this pipeline: the GitOps watcher creates them
# and deletes them when they drop out of the graph.
# Credentials never go here; reference a secret by name with SecretRef."""
SINKS_COMMENT = """\
# Sinks are real external systems. They're never generated, created or deleted
# by the pipeline, and they don't inherit Defaults: their connection is explicit."""
RELATION_COMMENT = """\
# Edges of the pipeline graph. One entry may chain several hops.
# InputSink / OutputSink are the graph's source and sink."""


# --------------------------------------------------------------------------- #
# manifest -> graph
# --------------------------------------------------------------------------- #

def parse_relation(relation) -> list[tuple[str, str]]:
    edges: list[tuple[str, str]] = []
    for entry in relation or []:
        if not isinstance(entry, str) or "->" not in entry:
            continue
        hops = [h.strip() for h in entry.split("->")]
        if all(hops):
            edges.extend(zip(hops, hops[1:]))
    return edges


def manifest_to_graph(text: str) -> dict:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("manifest is not a YAML mapping")
    nodes: list[dict] = []
    for node_id, kind in ((SOURCE, "source"), (SINK, "output")):
        sink = raw.get(node_id) if isinstance(raw.get(node_id), dict) else {}
        nodes.append({"id": node_id, "kind": kind, "sink": dict(sink)})
    for name, spec in (raw.get("Transformers") or {}).items():
        nodes.append({"id": str(name), "kind": "transformer", "transformer": dict(spec or {})})

    ids = {n["id"] for n in nodes}
    edges, seen, dropped = [], set(), []
    for u, v in parse_relation(raw.get("Relation")):
        if u not in ids or v not in ids:
            dropped.append(f"{u} -> {v}")
        elif (u, v) not in seen:
            seen.add((u, v))
            edges.append({"source": u, "target": v})
    return {
        "name": str(raw.get("Name") or ""),
        "defaults": dict(raw.get("Defaults") or {}),
        "schemas": {str(k): str(v) for k, v in (raw.get("Schemas") or {}).items()},
        "nodes": nodes,
        "edges": edges,
        "extra": {k: v for k, v in raw.items() if k not in TOP_LEVEL},
        "warnings": [f"Relation '{e}' refers to a node that doesn't exist; dropped" for e in dropped],
    }


# --------------------------------------------------------------------------- #
# graph -> manifest
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
        if not value:
            return [f"{pad}{_key(key)}: []"]
        lines = [f"{pad}{_key(key)}:"]
        for item in value:
            if isinstance(item, (dict, list)):
                dumped = yaml.safe_dump(item, sort_keys=False, default_flow_style=False, allow_unicode=True)
                first, *rest = dumped.rstrip("\n").splitlines()
                lines.append(f"{pad}  - {first}")
                lines += [f"{pad}    {r}" for r in rest]
            else:
                lines.append(f"{pad}  - {_scalar(item)}")
        return lines
    return [f"{pad}{_key(key)}: {_scalar(value)}"]


def _ordered(d: dict, known: tuple[str, ...]) -> list[tuple[str, Any]]:
    d = {k: v for k, v in (d or {}).items() if not _blank(v)}
    return [(k, d[k]) for k in known if k in d] + [(k, v) for k, v in d.items() if k not in known]


def _connection(settings: dict) -> dict:
    return dict(_ordered(settings, CONNECTION_KEYS))


def canonical_order(node_ids: list[str], edges: list[tuple[str, str]]) -> list[str]:
    """Kahn's algorithm with name-sorted ties (deploy.py's ordering); nodes on a cycle go last."""
    indeg = {n: 0 for n in node_ids}
    for u, v in edges:
        if u in indeg and v in indeg:
            indeg[v] += 1
    ready = sorted(n for n, d in indeg.items() if d == 0)
    order: list[str] = []
    while ready:
        n = ready.pop(0)
        order.append(n)
        for v in sorted({v for u, v in edges if u == n and v in indeg}):
            indeg[v] -= 1
            if indeg[v] == 0:
                ready.append(v)
        ready.sort()
    return order + sorted(n for n in node_ids if n not in order)


def graph_to_manifest(graph: dict) -> str:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = [(e["source"], e["target"]) for e in graph.get("edges", [])]
    rank = {n: i for i, n in enumerate(canonical_order(list(nodes), edges))}
    edges = sorted(dict.fromkeys(edges), key=lambda e: (rank.get(e[0], 1 << 30), rank.get(e[1], 1 << 30), e))

    sections: list[list[str]] = []

    sections.append([f"Name: {_scalar(graph.get('name') or '')}"])

    defaults = {k: v for k, v in (graph.get("defaults") or {}).items() if not _blank(v)}
    if defaults:
        lines = ["Defaults:"]
        for k, v in _ordered(defaults, ("Registry", "InternalDatasets")):
            if k == "Registry":
                lines.append(f"  {REGISTRY_COMMENT}")
                lines += _value_lines(k, v, 2)
            elif k == "InternalDatasets" and isinstance(v, dict):
                internal = dict(_ordered(v, INTERNAL_KEYS))
                if "ConnectionSettings" in internal:
                    internal["ConnectionSettings"] = _connection(internal["ConnectionSettings"])
                lines += [f"  {c}" for c in INTERNAL_COMMENT.splitlines()]
                lines += _value_lines(k, internal, 2)
            else:
                lines += _value_lines(k, v, 2)
        sections.append(lines)

    schemas = graph.get("schemas") or {}
    if schemas:
        sections.append(_value_lines("Schemas", dict(schemas), 0))

    for i, (node_id, comment) in enumerate(((SOURCE, SINKS_COMMENT), (SINK, None))):
        sink = dict(_ordered((nodes.get(node_id) or {}).get("sink") or {}, SINK_KEYS))
        if "ConnectionSettings" in sink:
            sink["ConnectionSettings"] = _connection(sink["ConnectionSettings"])
        lines = comment.splitlines() if comment else []
        lines += _value_lines(node_id, sink, 0) if sink else [f"{node_id}: {{}}"]
        sections.append(lines)

    transformers = sorted(
        (n for n in nodes.values() if n.get("kind") == "transformer"), key=lambda n: rank.get(n["id"], 1 << 30)
    )
    if transformers:
        lines = ["Transformers:"]
        for j, t in enumerate(transformers):
            if j:
                lines.append("")
            spec = dict(_ordered(t.get("transformer") or {}, TRANSFORMER_KEYS))
            if "Path" in spec:
                spec["Path"] = str(spec["Path"]).strip("/") or None
                spec = {k: v for k, v in spec.items() if v is not None}
            lines += _value_lines(t["id"], spec, 2) if spec else [f"  {_key(t['id'])}: {{}}"]
        sections.append(lines)

    for k, v in (graph.get("extra") or {}).items():
        if k not in TOP_LEVEL:
            sections.append(_value_lines(k, v, 0))

    if edges:
        sections.append(RELATION_COMMENT.splitlines() + ["Relation:"] + [f"  - {u} -> {v}" for u, v in edges])

    return "\n\n".join("\n".join(s) for s in sections) + "\n"
