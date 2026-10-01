"""Pipelines: deployed ones from PipelineDeploys/<Name>/manifest.yaml, drafts in the local
workspace, and Deploy (deploy.py's deploy with --pr).

Save writes the local workspace only:

    <workspace>/<Name>/manifest.yaml
    <workspace>/<Name>/<Name>.layout.json   node positions (the sidecar)
    <workspace>/<Name>/schemas/...           schema files, so deploy.py works on the folder as-is

It deliberately doesn't commit into PipelineDeploys/<Name>/: that folder is deploy.py's
rendered output, and `deploy.py check` in its CI rejects any file that isn't in
pipeline.lock.yaml — including a hand-written manifest or a layout file.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import re
import shutil
import tempfile
import threading
from pathlib import Path

from .foundry import Foundry
from .gitlab import GitLab
from .manifest import manifest_to_graph
from .validation import stage

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MR_URL_RE = re.compile(r"https?://\S+/-/merge_requests/\d+")


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
    def __init__(self, gitlab: GitLab, foundry: Foundry, workspace: Path, deploys_project: str, deploys_base: str):
        self.gitlab = gitlab
        self.foundry = foundry
        self.workspace = workspace
        self.deploys_project = deploys_project
        self.deploys_base = deploys_base
        # Schema files of deployed pipelines, fetched on load: name -> {relative path: bytes}
        self._deployed_schemas: dict[str, dict[str, bytes]] = {}
        self._deploy_lock = threading.Lock()

    # -- schema files ------------------------------------------------------------------ #

    def schema_resolver(self, name: str | None):
        draft_dir = self.workspace / name if name and NAME_RE.match(name) else None
        deployed = self._deployed_schemas.get(name or "", {})

        def resolve(rel: str) -> bytes | None:
            if draft_dir is not None:
                p = (draft_dir / rel).resolve()
                if p.is_file() and draft_dir.resolve() in p.parents:
                    return p.read_bytes()
            if rel in deployed:
                return deployed[rel]
            p = self.foundry.schema_file(rel)
            return p.read_bytes() if p else None

        return resolve

    # -- listing / loading ------------------------------------------------------------- #

    async def list(self) -> list[dict]:
        out: dict[str, dict] = {}
        try:
            proj = await self.gitlab.get_project(self.deploys_project)
            tree = await self.gitlab.list_tree(self.deploys_project, proj["default_branch"], recursive=False)
            dirs = [e["path"] for e in tree if e["type"] == "tree"]
            subtrees = await asyncio.gather(
                *(self.gitlab.list_tree(self.deploys_project, proj["default_branch"], d, recursive=False) for d in dirs)
            )
            for d, entries in zip(dirs, subtrees):
                if any(e["path"] == f"{d}/manifest.yaml" for e in entries):
                    out[d] = {"name": d, "deployed": True, "draft": False}
            error = None
        except Exception as e:
            error = str(e)
        if self.workspace.is_dir():
            for d in sorted(self.workspace.iterdir()):
                if (d / "manifest.yaml").is_file():
                    out.setdefault(d.name, {"name": d.name, "deployed": False, "draft": False})["draft"] = True
        return [{**v, "error": error} if error else v for _, v in sorted(out.items())]

    async def load(self, name: str, source: str | None = None) -> dict:
        check_name(name)
        draft = self.workspace / name / "manifest.yaml"
        if source in (None, "draft") and draft.is_file():
            text = draft.read_text()
            layout_file = self.workspace / name / f"{name}.layout.json"
            layout = json.loads(layout_file.read_text()) if layout_file.is_file() else None
            return {"source": "draft", "graph": manifest_to_graph(text), "layout": layout, "manifest": text}
        if source == "draft":
            raise PipelineError(404, f"no local draft of {name}")

        proj = await self.gitlab.get_project(self.deploys_project)
        ref = proj["default_branch"]
        raw = await self.gitlab.get_file(self.deploys_project, f"{name}/manifest.yaml", ref)
        if raw is None:
            raise PipelineError(404, f"{self.deploys_project} has no {name}/manifest.yaml")
        text = raw.decode()
        graph = manifest_to_graph(text)
        files = {}
        for rel in graph["schemas"].values():
            data = await self.gitlab.get_file(self.deploys_project, f"{name}/{rel}", ref)
            if data is not None:
                files[rel] = data
        self._deployed_schemas[name] = files
        return {"source": "deployed", "graph": graph, "layout": None, "manifest": text}

    # -- save --------------------------------------------------------------------------- #

    def save(self, graph: dict, layout: dict | None) -> dict:
        name = check_name(str(graph.get("name") or ""))
        target = self.workspace / name
        resolve = self.schema_resolver(name)
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / name
            stage(graph, staged, resolve)
            if layout is not None:
                (staged / f"{name}.layout.json").write_text(json.dumps(layout, indent=2, sort_keys=True) + "\n")
            elif (target / f"{name}.layout.json").is_file():
                shutil.copy2(target / f"{name}.layout.json", staged / f"{name}.layout.json")
            if target.exists():
                shutil.rmtree(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staged, target)
        return {"path": str(target / "manifest.yaml"), "layout": str(target / f"{name}.layout.json")}

    # -- deploy ------------------------------------------------------------------------- #

    def deploy(self, graph: dict, repo_url: str) -> dict:
        """Runs deploy.deploy(..., open_mr=True). Blocking: call it in a thread."""
        name = check_name(str(graph.get("name") or ""))
        d = self.foundry.deploy
        buf = io.StringIO()
        with self._deploy_lock, tempfile.TemporaryDirectory(prefix="studio-deploy-") as tmp:
            manifest = stage(graph, Path(tmp) / name, self.schema_resolver(name))
            try:
                with contextlib.redirect_stdout(buf):
                    d.deploy(manifest, repo_url, True)
            except d.ManifestError as e:
                errors = [self.foundry.locate(m.replace(str(manifest), "manifest.yaml")) for m in e.errors]
                raise PipelineError(422, f"manifest invalid ({len(errors)} errors)", errors, buf.getvalue())
            except RuntimeError as e:
                raise PipelineError(502, str(e), log=buf.getvalue())
        out = buf.getvalue()
        if "already up to date" in out:
            return {"status": "up_to_date", "mrUrl": None, "log": out}
        url = MR_URL_RE.search(out)
        branch = re.search(r"^pushed (\S+)", out, re.M)
        return {"status": "opened", "mrUrl": url.group(0) if url else None,
                "branch": branch.group(1) if branch else None, "log": out}
