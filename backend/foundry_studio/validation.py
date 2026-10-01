"""Validation passthrough: every rule and every message comes from deploy.py.

The graph is written to a manifest exactly as Save would write it, staged next to the
workspace's catalog and its schema files, and handed to deploy.load_pipeline. Errors are
only *located* here (attached to the node or edge they name), never produced.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import yaml

from .foundry import Foundry, dataset_node
from .manifest import catalog_to_yaml, graph_to_manifest, wiring

STAGED_CATALOG = "catalog.yaml"


def stage(graph: dict, catalog_path: Path, dest: Path, catalog: dict | None = None) -> Path:
    """manifest.yaml + catalog.yaml + the schema files the catalog names, in dest; returns the manifest.

    catalog: an edited, unsaved catalog to use instead of the file at catalog_path."""
    dest.mkdir(parents=True, exist_ok=True)
    if catalog is not None:
        (dest / STAGED_CATALOG).write_text(catalog_to_yaml(catalog))
    elif catalog_path.is_file():
        shutil.copyfile(catalog_path, dest / STAGED_CATALOG)
    if (dest / STAGED_CATALOG).is_file():
        raw = yaml.safe_load((dest / STAGED_CATALOG).read_text()) or {}
        for rel in ((raw.get("Schemas") or {}) if isinstance(raw, dict) else {}).values():
            src = (catalog_path.parent / str(rel)).resolve()
            target = (dest / str(rel)).resolve()
            if src.is_file() and dest.resolve() in target.parents:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, target)
    manifest = dest / "manifest.yaml"
    manifest.write_text(graph_to_manifest({**graph, "catalog": STAGED_CATALOG}))
    return manifest


class Validator:
    def __init__(self, foundry: Foundry):
        self.foundry = foundry
        self.deploy = foundry.deploy

    def _errors(self, e) -> list[dict]:
        return [self.foundry.locate(m) for m in e.errors]

    def validate(self, graph: dict, catalog_path: Path, catalog: dict | None = None) -> dict:
        manifest_text = graph_to_manifest(graph)
        with tempfile.TemporaryDirectory(prefix="studio-validate-") as tmp:
            manifest = stage(graph, catalog_path, Path(tmp), catalog)
            try:
                p = self.deploy.load_pipeline(manifest)
            except self.deploy.ManifestError as e:
                return {"ok": False, "errors": self._errors(e), "manifest": manifest_text, "summary": None}
        return {"ok": True, "errors": [], "manifest": manifest_text,
                "summary": self.deploy.describe(p).splitlines()[0], "sources": p.sources, "sinks": p.sinks}

    def validate_catalog(self, catalog: dict, catalog_path: Path) -> dict:
        """Check an edited catalog (not yet saved) with deploy.load_catalog."""
        with tempfile.TemporaryDirectory(prefix="studio-catalog-") as tmp:
            staged = Path(tmp) / STAGED_CATALOG
            staged.write_text(catalog_to_yaml(catalog))
            for rel in (catalog.get("schemas") or {}).values():
                src = (catalog_path.parent / str(rel)).resolve()
                target = (Path(tmp) / str(rel)).resolve()
                if src.is_file() and Path(tmp).resolve() in target.parents:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, target)
            try:
                self.deploy.load_catalog(staged)
            except self.deploy.ManifestError as e:
                return {"ok": False, "errors": self._errors(e)}
        return {"ok": True, "errors": []}

    def check_edge(self, graph: dict, source: str, target: str, catalog_path: Path,
                   catalog: dict | None = None) -> dict:
        """Would adding source -> target be accepted? deploy.py decides; we only add the canvas rules
        that come from the manifest's shape (an edge is an Input or the Output)."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        s, t = nodes.get(source), nodes.get(target)
        if not s or not t:
            return {"ok": False, "message": "unknown node"}
        kinds = (s.get("kind"), t.get("kind"))
        if kinds == ("transformer", "transformer"):
            return {"ok": False, "message": f"{source} -> {target}: transformers connect through a dataset; "
                                            "drop a dataset between them"}
        if kinds == ("dataset", "dataset"):
            return {"ok": False, "message": "datasets connect through a transformer"}

        edge = [source, target]
        before = {e["message"] for e in self.validate(graph, catalog_path, catalog)["errors"]}
        after = self.validate({**graph, "edges": [*graph.get("edges", []), {"source": source, "target": target}]},
                              catalog_path, catalog)
        mine = [e for e in after["errors"] if e["edge"] == edge
                or (e["message"].startswith("Transformers: cycle") and e["message"] not in before)]
        if mine:
            return {"ok": False, "message": mine[0]["message"], "errors": mine}
        return {"ok": True, "message": None}

    def endpoint(self, graph: dict, node: str, catalog: dict) -> dict:
        """The dataset a node is (or, for a transformer, writes), and how to connect to it."""
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        if node not in nodes:
            raise ValueError(f"unknown node {node!r}")
        n = nodes[node]
        outputs = wiring(graph).get(node, {}).get("Outputs") or [None]
        name = n["dataset"] if n.get("kind") == "dataset" else outputs[0]
        if not name:
            raise ValueError(f"{node} doesn't write a dataset yet")
        ds = (catalog.get("datasets") or {}).get(name)
        if ds is None:
            raise ValueError(f"{name} isn't in the catalog")
        cluster = str(ds.get("Cluster") or "")
        return {"endpoint": dataset_node(name), "dataset": name, "topic": name, "schema": ds.get("Schema"),
                "cluster": cluster, "connection": dict((catalog.get("clusters") or {}).get(cluster) or {})}
