"""Transformer discovery: find transformer folders in GitLab projects and list their versions.

A transformer is any folder with a `transformer.yaml` (name, in, out, description)
(foundry's TRANSFORMERS.md). A version from before its folder had one carries a warning.
"""

from __future__ import annotations

import asyncio
import posixpath
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

import yaml

from .gitlab import GitLab

DECL_FILE = "transformer.yaml"
PIPELINE_FILE = "PipelineManifest.yaml"
_SEMVER_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")


def semver_key(version: str) -> tuple:
    m = _SEMVER_RE.match(version)
    if not m:
        return (-1, -1, -1, 0, version)
    major, minor, patch, pre = m.groups()
    # A release sorts above its pre-releases.
    return (int(major), int(minor), int(patch), 0 if pre else 1, pre or "")


@dataclass
class Decl:
    name: str | None
    input: str | None
    output: str | None
    description: str
    source: str  # "transformer.yaml" | "none"
    warnings: list[str] = field(default_factory=list)


@dataclass
class Version:
    ref: str  # what goes into the manifest's Ref: a tag, or a full commit SHA
    label: str  # v0.4.2, or main@1a2b3c4d
    kind: str  # "tag" | "branch"
    commit: str
    committed_date: str | None
    input: str | None
    output: str | None
    source: str
    warnings: list[str]
    web_url: str


@dataclass
class TransformerInfo:
    id: str  # "<project>:<path>"
    project: str
    path: str
    name: str
    description: str
    repo: str
    web_url: str
    input: str | None
    output: str | None
    warnings: list[str]
    latest: str  # Ref of the newest version
    head: str  # commit SHA of the default branch
    versions: list[Version]

    def to_json(self) -> dict:
        return asdict(self)


class Discovery:
    def __init__(self, gitlab: GitLab, known_schemas: set[str] | Callable[[], set[str]]):
        self.gitlab = gitlab
        self.known_schemas = known_schemas
        self._decl_cache: dict[tuple[str, str, str], Decl] = {}  # (project, commit, path) -> Decl
        # Projects with a PipelineManifest.yaml at the root, as of their last scan: project -> GitLab project.
        self.pipeline_projects: dict[str, dict] = {}

    def _schema(self, value, where: str, warnings: list[str]) -> str | None:
        if value is None:
            warnings.append(f"{where}: not declared")
            return None
        value = str(value)
        known = self.known_schemas() if callable(self.known_schemas) else self.known_schemas
        if known and value not in known:  # empty: the schemas couldn't be read, so don't flag everything
            warnings.append(f"{where}: {value!r} is not a schema in foundry-models")
        return value

    async def declaration(self, project: str, path: str, commit: str) -> Decl:
        key = (project, commit, path)
        if key in self._decl_cache:
            return self._decl_cache[key]
        join = lambda f: posixpath.join(path, f) if path else f  # noqa: E731

        raw = await self.gitlab.get_file(project, join(DECL_FILE), commit)
        if raw is not None:
            warnings: list[str] = []
            try:
                spec = yaml.safe_load(raw) or {}
                if not isinstance(spec, dict):
                    raise ValueError("not a mapping")
            except (yaml.YAMLError, ValueError) as e:
                decl = Decl(None, None, None, "", DECL_FILE, [f"{DECL_FILE}: unreadable ({e})"])
            else:
                decl = Decl(
                    str(spec["name"]) if spec.get("name") else None,
                    self._schema(spec.get("in"), f"{DECL_FILE} in", warnings),
                    self._schema(spec.get("out"), f"{DECL_FILE} out", warnings),
                    str(spec.get("description") or "").strip(),
                    DECL_FILE,
                    warnings,
                )
        else:
            decl = Decl(None, None, None, "", "none", [f"no {DECL_FILE} in this version"])
        self._decl_cache[key] = decl
        return decl

    async def scan_project(self, project: str) -> dict[str, TransformerInfo]:
        proj = await self.gitlab.get_project(project)
        branch = proj["default_branch"]
        head = await self.gitlab.get_commit(project, branch)
        if head is None:
            self.pipeline_projects.pop(project, None)
            return {}
        tree = await self.gitlab.list_tree(project, head["id"], recursive=True)
        build_dirs = {"target", "bin", "obj", "node_modules", ".venv"}
        blobs = [e for e in tree if e["type"] == "blob" and not build_dirs & set(e["path"].split("/"))]
        folders = {posixpath.dirname(e["path"]) for e in blobs if posixpath.basename(e["path"]) == DECL_FILE}
        if any(e["path"] == PIPELINE_FILE for e in blobs):
            self.pipeline_projects[project] = proj
        else:
            self.pipeline_projects.pop(project, None)
        infos = await asyncio.gather(*(self._crate(proj, head, path) for path in sorted(folders)))
        return {i.id: i for i in infos}

    async def _crate(self, proj: dict, repo_head: dict, path: str) -> TransformerInfo:
        project = proj["path_with_namespace"]
        # The crate's newest default-branch version is the last commit that touched its folder.
        head = await self.gitlab.last_commit(project, repo_head["id"], path) or repo_head
        web = proj["web_url"]
        prefix = f"{path}/" if path else ""
        tag_re = re.compile(rf"^{re.escape(prefix)}(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")
        tags = [t for t in await self.gitlab.list_tags(project, f"^{prefix}v") if tag_re.match(t["name"])]

        head_decl = await self.declaration(project, path, head["id"])
        tag_decls = await asyncio.gather(*(self.declaration(project, path, t["commit"]["id"]) for t in tags))

        versions = [
            Version(
                ref=t["name"], label=tag_re.match(t["name"]).group(1), kind="tag", commit=t["commit"]["id"],
                committed_date=t["commit"].get("committed_date"), input=d.input, output=d.output,
                source=d.source, warnings=d.warnings, web_url=f"{web}/-/tree/{t['name']}/{path}".rstrip("/"),
            )
            for t, d in zip(tags, tag_decls)
        ]
        versions.sort(key=lambda v: semver_key(v.label), reverse=True)
        versions.append(Version(
            ref=head["id"], label=f"{proj['default_branch']}@{head['id'][:8]}", kind="branch", commit=head["id"],
            committed_date=head.get("committed_date"), input=head_decl.input, output=head_decl.output,
            source=head_decl.source, warnings=head_decl.warnings, web_url=f"{web}/-/tree/{head['id']}/{path}".rstrip("/"),
        ))
        latest = versions[0]
        name = head_decl.name or (posixpath.basename(path) if path else None) or project
        return TransformerInfo(
            id=f"{project}:{path}", project=project, path=path, name=name, description=head_decl.description,
            repo=proj["http_url_to_repo"], web_url=f"{web}/-/tree/{proj['default_branch']}/{path}".rstrip("/"),
            input=latest.input, output=latest.output, warnings=head_decl.warnings,
            latest=latest.ref, head=head["id"], versions=versions,
        )
