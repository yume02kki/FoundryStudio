"""Validation passthrough: every rule and every message comes from manifest.py's check().

The graph is written to a manifest exactly as Save would write it and handed to check(),
with the configs repo's profiles staged in a temporary checkout, its schema names, and each
processor's in/out schemas from its discovered processor.yaml at its Ref.
Errors are only *located* here (attached to the node or edge they name), never produced;
the one rule added is the canvas's own: a processor has a single In and a single Out.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Iterable
from pathlib import Path

import yaml

from .discovery import ProcessorInfo
from .foundry import Foundry, dataset_node
from .manifest import graph_to_manifest, wiring
from .sources import Sources

_PROFILE_MISSING = re.compile(r"^DataSets\.[^:]+: Config '[^']+' not found")


def _norm_repo(url: str | None) -> str:
    return (url or "").strip().lower().removesuffix("/").removesuffix(".git")


def find_info(spec: dict, infos: Iterable[ProcessorInfo]) -> ProcessorInfo | None:
    """The discovered processor a manifest entry runs (same repo and folder)."""
    repo, path = _norm_repo(spec.get("Repo")), str(spec.get("Path") or "").strip("/")
    return next((i for i in infos if _norm_repo(i.repo) == repo and i.path == path), None)


def declarations(graph: dict, infos: Iterable[ProcessorInfo]) -> dict[str, tuple[str | None, str | None]]:
    """Each processor's (in, out) from processor.yaml at its Ref (no Ref: the default branch)."""
    infos = list(infos)
    out = {}
    for n in graph.get("nodes", []):
        if n.get("kind") != "processor":
            continue
        spec = n.get("processor") or {}
        info = find_info(spec, infos)
        if not info:
            continue
        ref = spec.get("Ref")
        version = (next((v for v in info.versions if v.kind == "branch"), None) if not ref or ref == "HEAD" else
                   next((v for v in info.versions if v.ref == ref), None)
                   or next((v for v in info.versions if v.commit.startswith(str(ref))), None))
        if version and (version.input or version.output):
            out[n["id"]] = (version.input, version.output)
    return out


class Validator:
    def __init__(self, foundry: Foundry):
        self.foundry = foundry
        self.m = foundry.manifest

    def _shape_issues(self, graph: dict) -> list[dict]:
        issues = []
        for t, w in wiring(graph).items():
            for role, ds, edge in (("In", w["Inputs"], lambda d: [dataset_node(d), t]),
                                   ("Out", w["Outputs"], lambda d: [t, dataset_node(d)])):
                verb = "reads" if role == "In" else "writes"
                for extra in ds[1:]:
                    issues.append({"message": f"Processors.{t}.{role}: {t} {verb} {' and '.join(ds)}; "
                                              f"a processor {verb} one dataset",
                                   "node": None, "edge": edge(extra), "nodes": edge(extra), "field": role})
        return issues

    def validate(self, graph: dict, configs: dict | None, schemas: dict | None,
                 decls: dict[str, tuple[str | None, str | None]], configs_error: str | None = None) -> dict:
        manifest_text = graph_to_manifest(graph)
        manifest = yaml.safe_load(manifest_text) or {}
        issues = self._shape_issues(graph)
        with tempfile.TemporaryDirectory(prefix="studio-configs-") as tmp:
            if configs:
                Sources.stage(configs, Path(tmp))
            try:
                self.m.check(manifest, Path(tmp), set(schemas) if schemas is not None else None, decls)
            except self.m.ConfigError as e:
                messages = [m for m in e.errors if configs or not _PROFILE_MISSING.match(m)]
                issues += [self.foundry.locate(m) for m in messages]
        if configs_error:
            issues.insert(0, {"message": f"Configs: can't read the connection profiles: {configs_error}",
                              "node": None, "edge": None, "nodes": [], "field": "Configs"})
        datasets = manifest.get("DataSets") or {}
        processors = manifest.get("Processors") or {}
        written = {s.get("Out") for s in processors.values() if isinstance(s, dict)}
        read = {s.get("In") for s in processors.values() if isinstance(s, dict)}
        result = {"ok": not issues, "errors": issues, "manifest": manifest_text,
                  "summary": f"{len(processors)} processors, {len(datasets)} datasets",
                  "sources": sorted(d for d in datasets if d in read and d not in written),
                  "sinks": sorted(d for d in datasets if d in written and d not in read)}
        return result

    def check_edge(self, graph: dict, source: str, target: str, configs: dict | None, schemas: dict | None,
                   decls: dict) -> dict:
        """Would adding source -> target be accepted? check() decides; we only add the canvas rules
        that come from the manifest's shape (an edge is the processor's In or its Out)."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        s, t = nodes.get(source), nodes.get(target)
        if not s or not t:
            return {"ok": False, "message": "unknown node"}
        kinds = (s.get("kind"), t.get("kind"))
        if kinds == ("processor", "processor"):
            return {"ok": False, "message": f"{source} -> {target}: processors connect through a dataset; "
                                            "drop a dataset between them"}
        if kinds == ("dataset", "dataset"):
            return {"ok": False, "message": "datasets connect through a processor"}
        w = wiring(graph)
        if kinds == ("dataset", "processor") and w[target]["Inputs"]:
            return {"ok": False, "message": f"Processors.{target}.In: {target} already reads "
                                            f"{w[target]['Inputs'][0]}; a processor reads one dataset"}
        if kinds == ("processor", "dataset") and w[source]["Outputs"]:
            return {"ok": False, "message": f"Processors.{source}.Out: {source} already writes "
                                            f"{w[source]['Outputs'][0]}; a processor writes one dataset"}

        edge = [source, target]
        before = {e["message"] for e in self.validate(graph, configs, schemas, decls)["errors"]}
        after = self.validate({**graph, "edges": [*graph.get("edges", []), {"source": source, "target": target}]},
                              configs, schemas, decls)
        mine = [e for e in after["errors"] if e["edge"] == edge
                or (e["message"].startswith(("Processors: cycle", f"Processors.{source}: reads and writes",
                                             f"Processors.{target}: reads and writes"))
                    and e["message"] not in before)]
        if mine:
            return {"ok": False, "message": mine[0]["message"], "errors": mine}
        return {"ok": True, "message": None}

    def endpoint(self, graph: dict, node: str, configs: dict | None) -> dict:
        """The dataset a node is (or, for a processor, writes), and how to connect to it."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        if node not in nodes:
            raise ValueError(f"unknown node {node!r}")
        n = nodes[node]
        outputs = wiring(graph).get(node, {}).get("Outputs") or [None]
        name = n["dataset"] if n.get("kind") == "dataset" else outputs[0]
        if not name:
            raise ValueError(f"{node} doesn't write a dataset yet")
        spec = next((x.get("datasetSpec") for x in nodes.values() if x.get("dataset") == name), None)
        if not spec:
            raise ValueError(f"{name} isn't defined under DataSets")
        if not spec.get("Topic"):
            raise ValueError(f"{name} has no Topic")
        profile = str(spec.get("Config") or "")
        connection = dict(((configs or {}).get("profiles") or {}).get(profile) or {})
        connection.update(spec.get("ConnectionSettings") or {})  # inline settings override the profile's
        return {"endpoint": dataset_node(name), "dataset": name, "topic": str(spec["Topic"]),
                "schema": spec.get("DataSchema"), "cluster": profile or "inline", "connection": connection}
