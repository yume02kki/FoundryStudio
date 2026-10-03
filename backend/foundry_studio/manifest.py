"""UI graph <-> PipelineManifest.yaml.

The manifest format is the contract with foundry-platform/common/scripts (lib/pipeline.py), so the
UI never invents fields. On the canvas, processors and Kafkas are both nodes, and every edge is a
`Flow:` entry: Kafka -> processor (the processor reads it) or processor -> Kafka (it writes it).
Every entry under Kafkas is a node, wired or not. Node positions live in a separate
PipelineManifest.layout.json.

The manifest is written in one canonical form: the layout of the pipelines' own manifests,
processors in topological order (ties broken by name), Kafkas in the order data flows through
them, and Flow grouped by processor (what it reads, then what it writes). Comments above an entry
and at the end of a line are kept. A Flow whose entries didn't change keeps its own order and
grouping, so saving a manifest written by hand doesn't reshuffle it.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

from .foundry import DATASET, dataset_node

PROCESSOR_KEYS = ("Repo", "Ref", "Path")
KAFKA_KEYS = ("Config", "AllowedTypes", "Topic", "ConnectionSettings")
CONNECTION_KEYS = ("Brokers", "SecurityProtocol", "SaslMechanism", "SecretRef")
TOP_LEVEL = ("Name", "ConfigRegistry", "Kafkas", "Processors", "Flow")
DEFAULT_REF = "main"

HEADER = ("# yaml-language-server: $schema=https://gitlab.com/foundry-platform/common/scripts/-/jobs/artifacts/main/raw/"
          "manifest.schema.json?job=schema")
FLOW_INDENT = "    "


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


def _value_lines(key: str, value: Any, indent: int, path: tuple = (), trailing: dict | None = None) -> list[str]:
    """key: value as YAML lines; trailing maps a key path to the comment that ended its line."""
    pad = " " * indent
    path = (*path, str(key))
    note = (trailing or {}).get(path, "")
    if isinstance(value, dict):
        if not value:
            return [f"{pad}{_key(key)}: {{}}{note}"]
        lines = [f"{pad}{_key(key)}:{note}"]
        for k, v in value.items():
            lines += _value_lines(k, v, indent + 2, path, trailing)
        return lines
    if isinstance(value, list):
        if all(not isinstance(i, (dict, list)) for i in value):
            return [f"{pad}{_key(key)}: [{', '.join(_scalar(i) for i in value)}]{note}"]
        lines = [f"{pad}{_key(key)}:{note}"]
        for item in value:
            dumped = yaml.safe_dump(item, sort_keys=False, default_flow_style=False, allow_unicode=True)
            first, *rest = dumped.rstrip("\n").splitlines()
            lines.append(f"{pad}  - {first}")
            lines += [f"{pad}    {r}" for r in rest]
        return lines
    return [f"{pad}{_key(key)}: {_scalar(value)}{note}"]


def _comment_lines(node: dict) -> list[str]:
    """An entry's own comments (kept from the manifest it was loaded from), at entry indent."""
    return [f"  {c}" for c in node.get("comments") or [] if isinstance(c, str) and c.startswith("#")]


def _ordered(d: dict, known: tuple[str, ...]) -> dict:
    d = {k: v for k, v in (d or {}).items() if not _blank(v)}
    return {**{k: d[k] for k in known if k in d}, **{k: v for k, v in d.items() if k not in known}}


# --------------------------------------------------------------------------- #
# manifest -> graph
# --------------------------------------------------------------------------- #

_SECTION_RE = re.compile(r"^([A-Za-z]\w*):\s*(#.*)?$")
_ENTRY_RE = re.compile(r"""^  (?:"([^"]+)"|'([^']+)'|([^\s#'"][^:#]*?)):(?:\s|$)""")
_KEY_LINE_RE = re.compile(r"""^( *)(?:"([^"]+)"|'([^']+)'|([^\s#'"\-][^:#]*?)):(?:[^#]*?)(\s+#.*)?$""")


def _entry_comments(text: str) -> dict[tuple[str, str], list[str]]:
    """The comment lines right above each Kafkas/Processors entry, as written, so a save keeps them."""
    out: dict[tuple[str, str], list[str]] = {}
    section, pending = None, []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            pending.append(stripped)
            continue
        if (m := _SECTION_RE.match(line)) and not line.startswith(" "):
            section = m.group(1)
        elif section in ("Kafkas", "Processors") and (m := _ENTRY_RE.match(line)) and pending:
            out[(section, next(g for g in m.groups() if g is not None).strip())] = pending
        pending = []  # a blank line or anything else ends a comment block
    return out


def _trailing_comments(text: str) -> dict[str, str]:
    """Comments at the end of a `key: value` line ("Input: #mandatory"), by key path ("Kafkas/Input")."""
    out: dict[str, str] = {}
    stack: list[tuple[int, str]] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", "-")):
            continue
        m = _KEY_LINE_RE.match(line)
        if not m:
            continue
        indent, key = len(m.group(1)), next(g for g in m.groups()[1:4] if g is not None).strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        if m.group(5):
            out["/".join(k for _, k in stack)] = m.group(5)
    return out


def _flow_entries(raw: dict, text: str) -> list[str | None]:
    """Flow as written: its `A -> B` entries in order, None where a blank line separates groups."""
    entries: list[str | None] = []
    inside = False
    for line in text.splitlines():
        if not line.startswith((" ", "-")) and line.strip():
            inside = bool(re.match(r"^Flow:\s*(#.*)?$", line))
            continue
        if not inside:
            continue
        stripped = line.strip()
        if not stripped:
            if entries and entries[-1] is not None:
                entries.append(None)
        elif stripped.startswith("- "):
            entries.append(re.sub(r"\s+", " ", stripped[2:].split(" #")[0].strip()))
    while entries and entries[-1] is None:
        entries.pop()
    if not entries and isinstance(raw.get("Flow"), list):  # flow style: Flow: [A -> B, ...]
        entries = [str(e) for e in raw["Flow"]]
    return entries


def _pair(entry) -> tuple[str, str] | None:
    parts = [p.strip() for p in str(entry).split("->")] if isinstance(entry, str) else []
    return (parts[0], parts[1]) if len(parts) == 2 and all(parts) else None


def manifest_to_graph(text: str) -> dict:
    raw = yaml.safe_load(text) or {}
    if not isinstance(raw, dict):
        raise ValueError("manifest is not a YAML mapping")
    nodes: list[dict] = []
    edges: list[dict] = []
    warnings: list[str] = []
    kafkas = raw.get("Kafkas") if isinstance(raw.get("Kafkas"), dict) else {}
    processors = raw.get("Processors") if isinstance(raw.get("Processors"), dict) else {}
    comments = _entry_comments(text)

    def extra_comments(section: str, name: str) -> dict:
        return {"comments": comments[(section, name)]} if (section, name) in comments else {}

    for name, spec in kafkas.items():
        nodes.append({"id": dataset_node(str(name)), "kind": "dataset", "dataset": str(name),
                      **extra_comments("Kafkas", str(name)),
                      "datasetSpec": dict(spec) if isinstance(spec, dict) else {}})
    for name, spec in processors.items():
        nodes.append({"id": str(name), "kind": "processor", "processor": dict(spec) if isinstance(spec, dict) else {},
                      **extra_comments("Processors", str(name))})

    def node_id(name: str, other: str) -> str | None:
        if name in kafkas:
            return dataset_node(name)
        if name in processors:
            return name
        # Not defined: show it (as a Kafka next to a processor, else a processor), so the error has a node.
        as_kafka = other in processors
        nid = dataset_node(name) if as_kafka else name
        if not any(n["id"] == nid for n in nodes):
            nodes.append({"id": nid, "kind": "dataset", "dataset": name, "datasetSpec": None} if as_kafka
                         else {"id": nid, "kind": "processor", "processor": None})
            warnings.append(f"Flow uses {name}, which isn't under {'Kafkas' if as_kafka else 'Processors'}")
        return nid

    flow = _flow_entries(raw, text)
    for entry in flow:
        if entry is None:
            continue
        pair = _pair(entry)
        if not pair:
            warnings.append(f"Flow entry {entry!r} is not `A -> B`")
            continue
        a, b = pair
        edge = {"source": node_id(a, b), "target": node_id(b, a)}
        if edge not in edges:
            edges.append(edge)
    registry = raw.get("ConfigRegistry") if isinstance(raw.get("ConfigRegistry"), dict) else {}
    return {
        "name": str(raw.get("Name") or ""),
        "configs": {k: str(v) for k, v in registry.items() if not _blank(v)},
        "nodes": nodes,
        "edges": edges,
        "flow": flow,
        "comments": _trailing_comments(text),
        "extra": {k: v for k, v in raw.items() if k not in TOP_LEVEL},
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# graph -> manifest
# --------------------------------------------------------------------------- #

def wiring(graph: dict) -> dict[str, dict]:
    """Each processor's Inputs and Outputs (the Kafkas it reads and writes, in name order)."""
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


def _name(node: dict | None) -> str | None:
    if not node:
        return None
    return node["dataset"] if node.get("kind") == "dataset" else node["id"]


def flow_entries(graph: dict) -> list[str | None]:
    """The Flow to write: the loaded one if its entries are still exactly the edges, else canonical."""
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    entries = []
    for e in graph.get("edges", []):
        a, b = _name(nodes.get(e["source"])), _name(nodes.get(e["target"]))
        if a and b and f"{a} -> {b}" not in entries:
            entries.append(f"{a} -> {b}")
    loaded = [f for f in graph.get("flow") or [] if f is not None]
    if loaded and sorted(loaded) == sorted(entries) and len(set(loaded)) == len(loaded):
        return list(graph["flow"])
    wired = wiring(graph)
    out: list[str | None] = []
    done: set[str] = set()
    for t in canonical_order(wired):
        group = [f"{d} -> {t}" for d in wired[t]["Inputs"]] + [f"{t} -> {d}" for d in wired[t]["Outputs"]]
        if group:
            out += ([None] if out else []) + group
            done |= set(group)
    if rest := [f for f in entries if f not in done]:  # Kafka -> Kafka and the like: validation says so
        out += ([None] if out else []) + rest
    return out


def graph_to_manifest(graph: dict) -> str:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    wired = wiring(graph)
    order = canonical_order(wired)
    trailing = {tuple(k.split("/")): v for k, v in (graph.get("comments") or {}).items()}
    sections: list[list[str]] = [[HEADER, _value_lines("Name", graph.get("name") or "", 0, (), trailing)[0]]]

    registry = _ordered(graph.get("configs") or {}, ("Repo", "Ref"))
    if registry:
        sections.append(_value_lines("ConfigRegistry", registry, 0, (), trailing))

    # Kafkas in the order data flows through them, then any that nothing reads or writes.
    names: list[str] = []
    for t in order:
        names += [d for d in wired[t]["Inputs"] + wired[t]["Outputs"] if d not in names]
    defined = {n["dataset"]: n.get("datasetSpec") for n in nodes.values() if n.get("kind") == "dataset"}
    names += sorted(d for d in defined if d not in names)
    entries = []
    for d in names:
        spec = defined.get(d)
        if spec is None:
            continue  # used in Flow but undefined: validation says so
        spec = dict(spec)
        if isinstance(spec.get("ConnectionSettings"), dict):
            spec["ConnectionSettings"] = _ordered(spec["ConnectionSettings"], CONNECTION_KEYS)
        spec = _ordered(spec, KAFKA_KEYS)
        node = nodes.get(dataset_node(d)) or {}
        entries.append(_comment_lines(node) + _value_lines(d, spec, 2, ("Kafkas",), trailing))
    if entries:
        lines = ["Kafkas:"]
        for j, entry in enumerate(entries):
            lines += ([""] if j else []) + entry
        sections.append(lines)

    if order:
        lines = ["Processors:"]
        for j, t in enumerate(order):
            spec = dict(nodes[t].get("processor") or {})
            if spec.get("Path") is not None:
                spec["Path"] = str(spec["Path"]).strip("/")
            spec = _ordered(spec, PROCESSOR_KEYS)
            lines += ([""] if j else []) + _comment_lines(nodes[t]) + _value_lines(t, spec, 2, ("Processors",), trailing)
        sections.append(lines)

    flow = flow_entries(graph)
    if flow:
        sections.append(["Flow:"] + [f"{FLOW_INDENT}- {f}" if f is not None else "" for f in flow])

    for k, v in (graph.get("extra") or {}).items():
        if k not in TOP_LEVEL:
            sections.append(_value_lines(k, v, 0))
    return "\n\n".join("\n".join(s) for s in sections) + "\n"


def is_dataset(node_id: str) -> bool:
    return node_id.startswith(DATASET)
