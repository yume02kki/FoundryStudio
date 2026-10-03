"""Validation passthrough: every rule and every message comes from foundry-platform/common/scripts.

The graph is written to a manifest exactly as Save would write it and handed to the pipelines CI's
validators: validators/pipelines/typecheck.py's check() (with each processor's processor.yaml at
its Ref, as discovered, and the classes in Foundry.Common.Models) and cycles.py, plus
lib/pipeline.py's load_profile() for every Kafka's Config, against the configRegistry's profiles
staged in a temporary checkout. Errors are only *located* here (attached to the node or edge they
name), never produced.
"""

from __future__ import annotations

import tempfile
from collections.abc import Iterable
from pathlib import Path

import yaml

from .discovery import ProcessorInfo
from .foundry import Foundry, dataset_node, locate
from .manifest import graph_to_manifest, wiring
from .sources import Sources


def _norm_repo(url: str | None) -> str:
    return (url or "").strip().lower().removesuffix("/").removesuffix(".git")


def find_info(spec: dict | None, infos: Iterable[ProcessorInfo]) -> ProcessorInfo | None:
    """The discovered processor a manifest entry runs (same repo and folder)."""
    spec = spec or {}
    repo, path = _norm_repo(spec.get("Repo")), str(spec.get("Path") or "").strip("/")
    return next((i for i in infos if _norm_repo(i.repo) == repo and i.path == path), None)


def _types(label: str | None) -> list[str]:
    """Discovery's "A | B" back to a list."""
    return [t for t in (label or "").split(" | ") if t]


def declarations(graph: dict, infos: Iterable[ProcessorInfo]) -> dict[str, dict]:
    """Each processor's processor.yaml (in, out, Runtime) at its Ref (no Ref: the default branch)."""
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
        branch = next((v for v in info.versions if v.kind == "branch"), None)
        version = (branch if not ref or ref == "HEAD" or (branch and ref == branch.label.split("@")[0]) else
                   next((v for v in info.versions if v.ref == ref), None)
                   or next((v for v in info.versions if v.commit.startswith(str(ref))), None))
        if version and version.input and version.output:
            out[n["id"]] = {"in": _types(version.input), "out": _types(version.output), "Runtime": version.runtime}
    return out


class Validator:
    def __init__(self, foundry: Foundry):
        self.foundry = foundry

    def _messages(self, manifest: dict, configs: dict | None, types: list[str] | None, decls: dict) -> list[str]:
        p = self.foundry.pipeline
        kafkas = p.section(manifest, "Kafkas")
        # Unknown types (the models repo couldn't be read): accept what the manifest names rather than flag it all.
        known = set(types) if types is not None else {t for k in kafkas.values() if isinstance(k, dict)
                                                       for t in p.types_of(k.get("AllowedTypes"))}
        messages = self.foundry.typecheck.check(manifest, decls, known)
        edges, _ = p.flow(manifest)
        messages += [f"Flow has a cycle: {' -> '.join(c)}" for c in self.foundry.cycles.cycles(edges)]
        if configs:
            with tempfile.TemporaryDirectory(prefix="studio-registry-") as tmp:
                Sources.stage(configs, Path(tmp))
                for name, spec in kafkas.items():
                    if isinstance(spec, dict) and spec.get("Config"):
                        try:
                            p.load_profile(Path(tmp), spec["Config"])
                        except p.ConfigError as e:
                            messages += [f"Kafkas.{name}.Config: {m}" for m in e.errors]
        return messages

    def validate(self, graph: dict, configs: dict | None, types: list[str] | None,
                 decls: dict[str, dict], configs_error: str | None = None) -> dict:
        manifest_text = graph_to_manifest(graph)
        manifest = yaml.safe_load(manifest_text) or {}
        kafkas = set(self.foundry.pipeline.section(manifest, "Kafkas"))
        processors = set(self.foundry.pipeline.section(manifest, "Processors"))
        issues = [locate(m, kafkas, processors) for m in self._messages(manifest, configs, types, decls)]
        if configs_error:
            issues.insert(0, {"message": f"ConfigRegistry: can't read the connection profiles: {configs_error}",
                              "node": None, "edge": None, "nodes": [], "field": "ConfigRegistry"})
        wired = wiring(graph)
        written = {d for w in wired.values() for d in w["Outputs"]}
        read = {d for w in wired.values() for d in w["Inputs"]}
        return {"ok": not issues, "errors": issues, "manifest": manifest_text,
                "summary": f"{len(processors)} processors, {len(kafkas)} Kafkas",
                "sources": sorted(d for d in kafkas if d in read and d not in written),
                "sinks": sorted(d for d in kafkas if d in written and d not in read)}

    def check_edge(self, graph: dict, source: str, target: str, configs: dict | None, types: list[str] | None,
                   decls: dict) -> dict:
        """Would adding source -> target be accepted? The validators decide; we only add the canvas rules
        that come from the manifest's shape (a processor writes one Kafka; a dotnet one reads one)."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        s, t = nodes.get(source), nodes.get(target)
        if not s or not t:
            return {"ok": False, "message": "unknown node"}
        kinds = (s.get("kind"), t.get("kind"))
        if kinds == ("processor", "processor"):
            return {"ok": False, "message": f"{source} -> {target}: processors connect through a Kafka; "
                                            "drop a Kafka between them"}
        if kinds == ("dataset", "dataset"):
            return {"ok": False, "message": "Kafkas connect through a processor"}
        w = wiring(graph)
        if kinds == ("dataset", "processor") and w[target]["Inputs"] \
                and (decls.get(target) or {}).get("Runtime", "dotnet") != "flink":
            return {"ok": False, "message": f"{target}: already reads {w[target]['Inputs'][0]}; "
                                            "a dotnet processor reads one Kafka"}
        if kinds == ("processor", "dataset") and w[source]["Outputs"]:
            return {"ok": False, "message": f"{source}: already writes {w[source]['Outputs'][0]}; "
                                            "a processor writes one Kafka"}

        edge = [source, target]
        before = {e["message"] for e in self.validate(graph, configs, types, decls)["errors"]}
        after = self.validate({**graph, "edges": [*graph.get("edges", []), {"source": source, "target": target}]},
                              configs, types, decls)
        mine = [e for e in after["errors"] if e["message"] not in before
                and (e["edge"] == edge or e["message"].startswith("Flow has a cycle"))]
        if mine:
            return {"ok": False, "message": mine[0]["message"], "errors": mine}
        return {"ok": True, "message": None}

    def endpoint(self, graph: dict, node: str, configs: dict | None) -> dict:
        """The Kafka a node is (or, for a processor, writes), and how to connect to it."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        if node not in nodes:
            raise ValueError(f"unknown node {node!r}")
        n = nodes[node]
        outputs = wiring(graph).get(node, {}).get("Outputs") or [None]
        name = n["dataset"] if n.get("kind") == "dataset" else outputs[0]
        if not name:
            raise ValueError(f"{node} doesn't write a Kafka yet")
        spec = next((x.get("datasetSpec") for x in nodes.values() if x.get("dataset") == name), None)
        if not spec:
            raise ValueError(f"{name} isn't defined under Kafkas")
        if not spec.get("Topic"):
            raise ValueError(f"{name} has no Topic")
        profile = str(spec.get("Config") or "")
        connection = dict(((configs or {}).get("profiles") or {}).get(profile) or {})
        connection.update(spec.get("ConnectionSettings") or {})  # inline settings override the profile's
        types = spec.get("AllowedTypes")
        return {"endpoint": dataset_node(name), "dataset": name, "topic": str(spec["Topic"]),
                "types": [str(t) for t in types] if isinstance(types, list) else [],
                "cluster": profile or "inline", "connection": connection}
