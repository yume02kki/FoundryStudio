"""Validation passthrough: every rule and every message comes from deploy.py.

The graph is written to a manifest exactly as Save/Deploy would write it, staged next to
its schema files, and handed to deploy.load_pipeline. Errors are only *located* here
(attached to the node or edge they name), never produced.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from pathlib import Path

from .foundry import Foundry
from .manifest import SINK, SOURCE, graph_to_manifest

# Returns a schema file's bytes for a manifest-relative path, or None.
SchemaResolver = Callable[[str], bytes | None]


def stage(graph: dict, dest: Path, resolve_schema: SchemaResolver) -> Path:
    """Write manifest.yaml plus the schema files it references into dest; returns the manifest path."""
    dest.mkdir(parents=True, exist_ok=True)
    manifest = dest / "manifest.yaml"
    manifest.write_text(graph_to_manifest(graph))
    for rel in (graph.get("schemas") or {}).values():
        rel = str(rel)
        target = (dest / rel).resolve()
        if dest.resolve() not in target.parents:
            continue  # never write outside the staging dir; deploy.py reports the file as missing
        data = resolve_schema(rel)
        if data is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return manifest


class Validator:
    def __init__(self, foundry: Foundry):
        self.foundry = foundry
        self.deploy = foundry.deploy

    def validate(self, graph: dict, resolve_schema: SchemaResolver) -> dict:
        manifest_text = graph_to_manifest(graph)
        with tempfile.TemporaryDirectory(prefix="studio-validate-") as tmp:
            manifest = stage(graph, Path(tmp), resolve_schema)
            try:
                p = self.deploy.load_pipeline(manifest)
            except self.deploy.ManifestError as e:
                errors = [self.foundry.locate(m.replace(str(manifest), "manifest.yaml")) for m in e.errors]
                return {"ok": False, "errors": errors, "manifest": manifest_text,
                        "topics": self.topics(graph), "summary": None}
        endpoints = self.deploy.endpoints(p)
        internal = sorted(k for k in endpoints if k not in self.deploy.SINKS)
        return {
            "ok": True, "errors": [], "manifest": manifest_text, "topics": self.topics(graph),
            "summary": f"{p.name}: OK — {len(p.transformers)} transformers, {len(p.edges)} edges, "
                       f"2 external sinks, {len(internal)} internal datasets",
            "internalDatasets": internal,
        }

    def _pipeline(self, graph: dict, edges: list[tuple[str, str]]):
        d = self.deploy
        transformers = {}
        sinks = {SOURCE: {}, SINK: {}}
        for n in graph.get("nodes", []):
            if n.get("kind") == "transformer":
                spec = n.get("transformer") or {}
                transformers[n["id"]] = d.Transformer(
                    n["id"], str(spec.get("Repo", "")), str(spec.get("Ref", "")), str(spec.get("Path", "")),
                    spec.get("IN"), spec.get("OUT"),
                )
            elif n["id"] in sinks:
                sink = n.get("sink") or {}
                sinks[n["id"]] = {"Ontology": sink.get("Ontology"), "Topic": sink.get("Topic") or ""}
        return d.Pipeline(
            name=str(graph.get("name") or "Pipeline"), base_dir=Path("."), schemas={}, defaults={}, order=[],
            input_sink=sinks[SOURCE], output_sink=sinks[SINK], transformers=transformers, edges=edges,
        )

    def topics(self, graph: dict) -> dict[str, dict]:
        """The topic each edge carries, per Pipeline.writes_to (internal ones are generated)."""
        edges = [(e["source"], e["target"]) for e in graph.get("edges", [])]
        p = self._pipeline(graph, edges)
        out = {}
        for u, v in edges:
            if u != SOURCE and u not in p.transformers:
                continue
            ep = p.writes_to(u)
            if ep in self.deploy.SINKS:
                topic = (p.input_sink if ep == SOURCE else p.output_sink).get("Topic") or ""
                out[f"{u}->{v}"] = {"topic": topic, "internal": False}
            else:
                out[f"{u}->{v}"] = {"topic": ep, "internal": True}
        return out

    def endpoint(self, graph: dict, node: str) -> dict:
        """The topic a node writes (for a sink: the sink's own topic), and how to connect to it.

        Uses deploy.py's Pipeline.writes_to, so a transformer's output is exactly the topic deploy.py
        generates: <Pipeline>.<Transformer>.out, or OutputSink's topic when it feeds it.
        """
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        if node not in nodes:
            raise ValueError(f"unknown node {node!r}")
        edges = [(e["source"], e["target"]) for e in graph.get("edges", [])]
        ep = node if node in (SOURCE, SINK) else self._pipeline(graph, edges).writes_to(node)
        if ep in (SOURCE, SINK):
            sink = nodes.get(ep, {}).get("sink") or {}
            return {"endpoint": ep, "topic": str(sink.get("Topic") or ""), "schema": sink.get("Ontology"),
                    "connection": sink.get("ConnectionSettings") or {}, "internal": False}
        internal = ((graph.get("defaults") or {}).get("InternalDatasets") or {})
        return {"endpoint": ep, "topic": ep, "schema": (nodes[node].get("transformer") or {}).get("OUT"),
                "connection": internal.get("ConnectionSettings") or {}, "internal": True}

    def check_edge(self, graph: dict, source: str, target: str) -> dict:
        """Would adding source -> target be accepted? Uses deploy.py's own graph checks."""
        existing = [(e["source"], e["target"]) for e in graph.get("edges", [])]
        prefix = f"Relation '{source} -> {target}'"

        def run(edges):
            errors: list[str] = []
            self.deploy.validate_graph(self._pipeline(graph, edges), errors)
            return errors

        p = self._pipeline(graph, existing)
        nodes = {SOURCE, SINK, *p.transformers}
        if source in nodes and target in nodes and source != SINK and target != SOURCE and source != target:
            emits, expects = p.emits(source), p.expects(target)
            if emits is None or expects is None:
                # Not typed yet (e.g. a sink without Ontology): deploy.py will report the missing field.
                return {"ok": True, "message": None}
        errors = run(existing + [(source, target)])
        mine = [e for e in errors if e.startswith(prefix)]
        if not mine:
            # Graph-level errors this edge would introduce: a cycle, or a transformer
            # that would publish to OutputSink and feed internal steps at once.
            before = set(run(existing))
            caused = ("Relation: cycle", f"Transformers.{source}: feeds both")
            mine = [e for e in errors if e.startswith(caused) and e not in before]
        if mine:
            return {"ok": False, "message": mine[0], "errors": [self.foundry.locate(m) for m in mine]}
        return {"ok": True, "message": None}
