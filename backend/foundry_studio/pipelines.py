"""The workspace: one folder per pipeline, ideally a checkout of the pipeline's repo.

    <workspace>/<folder>/PipelineManifest.yaml           the pipeline
    <workspace>/<folder>/PipelineManifest.layout.json    node positions (the sidecar)

A pipeline is known by its folder; its Name is a field in the manifest. A new pipeline gets a
folder named after it. Studio only edits and displays these files: Save writes them and
nothing else, and committing and pushing is up to you.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from .manifest import graph_to_manifest, manifest_to_graph

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MANIFEST = "PipelineManifest.yaml"
LAYOUT = "PipelineManifest.layout.json"


class PipelineError(Exception):
    def __init__(self, status: int, message: str, errors: list[dict] | None = None, log: str = ""):
        self.status = status
        self.errors = errors or []
        self.log = log
        super().__init__(message)


def check_name(name: str) -> str:
    if not NAME_RE.match(name or ""):
        raise PipelineError(400, f"pipeline name {name!r} must match {NAME_RE.pattern}")
    return name


class PipelineStore:
    def __init__(self, workspace: Path):
        self.workspace = workspace

    def list(self) -> list[dict]:
        out = []
        if self.workspace.is_dir():
            for d in sorted(self.workspace.iterdir(), key=lambda p: p.name.lower()):
                if (d / MANIFEST).is_file() and NAME_RE.match(d.name):
                    try:
                        name = manifest_to_graph((d / MANIFEST).read_text())["name"]
                    except (ValueError, yaml.YAMLError):  # still listed, so it can be opened and fixed
                        name = ""
                    out.append({"folder": d.name, "name": name or d.name})
        return out

    def datasets(self) -> list[dict]:
        """Every pipeline's DataSets entries, for reusing a topic another pipeline already defines."""
        out = []
        for p in self.list():
            try:
                raw = yaml.safe_load((self.workspace / p["folder"] / MANIFEST).read_text()) or {}
            except yaml.YAMLError:
                continue
            datasets = raw.get("DataSets") if isinstance(raw, dict) else None
            for name, spec in (datasets if isinstance(datasets, dict) else {}).items():
                if isinstance(spec, dict):
                    out.append({"folder": p["folder"], "pipeline": p["name"], "name": str(name), "spec": spec})
        return out

    def load(self, folder: str) -> dict:
        check_name(folder)
        f = self.workspace / folder / MANIFEST
        if not f.is_file():
            raise PipelineError(404, f"no {MANIFEST} in {self.workspace / folder}")
        text = f.read_text()
        try:
            graph = manifest_to_graph(text)
        except (ValueError, yaml.YAMLError) as e:
            raise PipelineError(422, f"{f}: {e}")
        layout_file = self.workspace / folder / LAYOUT
        layout = json.loads(layout_file.read_text()) if layout_file.is_file() else None
        return {"graph": graph, "layout": layout, "manifest": text, "path": str(f), "folder": folder}

    def save(self, folder: str | None, graph: dict, layout: dict | None) -> dict:
        """Save to folder, or for a new pipeline (folder None) to a new folder named after it."""
        if folder is None:
            folder = check_name(str(graph.get("name") or ""))
            if (self.workspace / folder / MANIFEST).exists():
                raise PipelineError(409, f"{self.workspace / folder} already has a pipeline; open it instead")
        target = self.workspace / check_name(folder)
        target.mkdir(parents=True, exist_ok=True)
        (target / MANIFEST).write_text(graph_to_manifest(graph))
        if layout is not None:
            (target / LAYOUT).write_text(json.dumps(layout, indent=2, sort_keys=True) + "\n")
        return {"path": str(target / MANIFEST), "layout": str(target / LAYOUT), "folder": folder}
