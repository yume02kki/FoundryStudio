"""The workspace: the shared catalog and one folder per pipeline, plus deploys.

    <workspace>/catalog.yaml                 clusters, schemas, registered topics (datasets)
    <workspace>/schemas/...                  the schema files the catalog names
    <workspace>/<Name>/manifest.yaml         the pipeline (Catalog: ../catalog.yaml)
    <workspace>/<Name>/<Name>.layout.json    node positions (the sidecar)

Studio only edits and displays these files; Save writes them and nothing else. Deploy runs
deploy.py's deploy on the saved manifest against the deploy target (STUDIO_DEPLOY_TARGET),
which records every deploy; history, rollback and stop read and use that record.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
from pathlib import Path

import yaml

from .foundry import Foundry
from .manifest import catalog_to_yaml, graph_to_manifest, manifest_to_graph, parse_catalog

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CATALOG = "catalog.yaml"
DEFAULT_CATALOG_REF = f"../{CATALOG}"


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


def seed(root: Path, foundry: Foundry) -> None:
    """A new workspace starts with foundry's example catalog, its schemas and SWpipeline."""
    root.mkdir(parents=True, exist_ok=True)
    if (root / CATALOG).exists():
        return
    shutil.copyfile(foundry.example_catalog, root / CATALOG)
    catalog = parse_catalog((root / CATALOG).read_text())
    for rel in catalog["schemas"].values():
        src, dst = foundry.root / rel, root / rel
        if src.is_file() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
    graph = manifest_to_graph(foundry.example_manifest.read_text())
    (root / graph["name"]).mkdir(exist_ok=True)
    (root / graph["name"] / "manifest.yaml").write_text(graph_to_manifest({**graph, "catalog": DEFAULT_CATALOG_REF}))


class PipelineStore:
    def __init__(self, foundry: Foundry, workspace: Path, target_file: Path | None):
        self.foundry = foundry
        self.workspace = workspace
        self.target_file = target_file
        self._deploy_lock = threading.Lock()

    # -- catalog ------------------------------------------------------------------------ #

    @property
    def catalog_path(self) -> Path:
        return self.workspace / CATALOG

    def catalog(self) -> dict:
        if not self.catalog_path.is_file():
            return {"clusters": {}, "schemas": {}, "datasets": {}, "extra": {}, "schemaInfo": {}}
        cat = parse_catalog(self.catalog_path.read_text())
        info = {}
        for name, rel in cat["schemas"].items():
            p = (self.workspace / rel).resolve()
            try:
                spec = yaml.safe_load(p.read_text()) if p.is_file() and self.workspace.resolve() in p.parents else None
            except yaml.YAMLError:
                spec = None
            spec = spec if isinstance(spec, dict) else {}
            info[name] = {"file": rel, "format": spec.get("format"),
                          "fields": {str(k): str(v) for k, v in (spec.get("fields") or {}).items()}}
        return {**cat, "schemaInfo": info}

    def save_catalog(self, catalog: dict) -> dict:
        self.workspace.mkdir(parents=True, exist_ok=True)
        text = catalog_to_yaml(catalog)
        self.catalog_path.write_text(text)
        return {"path": str(self.catalog_path), "catalog": self.catalog()}

    # -- pipelines ---------------------------------------------------------------------- #

    def list(self) -> list[dict]:
        out = []
        if self.workspace.is_dir():
            for d in sorted(self.workspace.iterdir()):
                if (d / "manifest.yaml").is_file() and NAME_RE.match(d.name):
                    out.append({"name": d.name, "deploy": self.current(d.name)})
        return out

    def load(self, name: str) -> dict:
        check_name(name)
        f = self.workspace / name / "manifest.yaml"
        if not f.is_file():
            raise PipelineError(404, f"no pipeline {name} in {self.workspace}")
        text = f.read_text()
        layout_file = self.workspace / name / f"{name}.layout.json"
        layout = json.loads(layout_file.read_text()) if layout_file.is_file() else None
        return {"graph": manifest_to_graph(text), "layout": layout, "manifest": text, "path": str(f)}

    def save(self, graph: dict, layout: dict | None) -> dict:
        name = check_name(str(graph.get("name") or ""))
        target = self.workspace / name
        target.mkdir(parents=True, exist_ok=True)
        graph = {**graph, "catalog": graph.get("catalog") or DEFAULT_CATALOG_REF}
        (target / "manifest.yaml").write_text(graph_to_manifest(graph))
        if layout is not None:
            (target / f"{name}.layout.json").write_text(json.dumps(layout, indent=2, sort_keys=True) + "\n")
        return {"path": str(target / "manifest.yaml"), "layout": str(target / f"{name}.layout.json")}

    # -- deploys ------------------------------------------------------------------------ #

    def target(self):
        d = self.foundry.deploy
        if self.target_file is None:
            raise PipelineError(400, "deploying needs a target: set STUDIO_DEPLOY_TARGET to a target.yaml "
                                     "(see foundry's target.example.yaml)")
        try:
            return d.Target.load(self.target_file)
        except d.ManifestError as e:
            raise PipelineError(400, f"{self.target_file}: {'; '.join(e.errors)}")

    def current(self, name: str) -> dict | None:
        if self.target_file is None:
            return None
        try:
            return self.foundry.deploy.current(self.target(), name)
        except (PipelineError, OSError, yaml.YAMLError):
            return None

    def history(self, name: str) -> dict:
        check_name(name)
        t = self.target()
        d = self.foundry.deploy
        try:
            services = d.runner_for(t, lambda _: None).ps(t.project(name))
            services_error = None
        except d.DeployError as e:
            services, services_error = [], str(e)
        return {"current": d.current(t, name), "history": d.history(t, name), "runner": t.runner,
                "project": t.project(name), "services": services, "servicesError": services_error}

    def _run(self, fn, log) -> dict:
        d = self.foundry.deploy
        if not self._deploy_lock.acquire(blocking=False):
            raise PipelineError(409, "another deploy is running")
        try:
            return fn()
        except d.ManifestError as e:
            raise PipelineError(422, f"manifest invalid ({len(e.errors)} errors)",
                                [self.foundry.locate(m) for m in e.errors])
        except d.DeployError as e:
            raise PipelineError(502, str(e))
        finally:
            self._deploy_lock.release()

    def deploy(self, name: str, log) -> dict:
        """deploy.py deploy on the saved manifest. Blocking: call it in a thread."""
        check_name(name)
        manifest = self.workspace / name / "manifest.yaml"
        if not manifest.is_file():
            raise PipelineError(404, f"{name} isn't saved yet; save it, then deploy")
        target = self.target()
        return self._run(lambda: self.foundry.deploy.deploy(manifest, target, log), log)

    def rollback(self, name: str, deploy_id: str, log) -> dict:
        check_name(name)
        target = self.target()
        return self._run(lambda: self.foundry.deploy.rollback(name, deploy_id, target, log), log)

    def stop(self, name: str, log) -> dict:
        check_name(name)
        target = self.target()
        return self._run(lambda: self.foundry.deploy.stop(name, target, log), log)
