"""Processor discovery: find processor folders in GitLab projects and list their versions.

A processor is any folder with a `processor.yaml` (name, description, Runtime, in, out: lists of
type names, the classes in Foundry.Common.Models). A version from before its folder had one
carries a warning.
"""

from __future__ import annotations

import asyncio
import posixpath
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

import yaml

from .gitlab import GitLab

DECL_FILE = "processor.yaml"
RUNTIMES = ("dotnet", "flink")
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
    source: str  # "processor.yaml" | "none"
    warnings: list[str] = field(default_factory=list)
    runtime: str = "dotnet"


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
    runtime: str = "dotnet"


@dataclass
class ProcessorInfo:
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
    runtime: str = "dotnet"

    def to_json(self) -> dict:
        return asdict(self)


class Discovery:
    def __init__(self, gitlab: GitLab, known_types: set[str] | Callable[[], set[str]]):
        self.gitlab = gitlab
        self.known_types = known_types
        self._decl_cache: dict[tuple[str, str, str], Decl] = {}  # (project, commit, path) -> Decl

    def _types(self, value, where: str, warnings: list[str]) -> str | None:
        """Declared types (a list) as "A | B", how the UI shows them."""
        if not value:
            warnings.append(f"{where}: not declared")
            return None
        if not isinstance(value, list):
            warnings.append(f"{where}: should be a list, e.g. [{value}]")
        names = [str(v) for v in value] if isinstance(value, list) else [str(value)]
        known = self.known_types() if callable(self.known_types) else self.known_types
        for name in names:
            if known and name not in known:  # empty: the types couldn't be read, so don't flag everything
                warnings.append(f"{where}: {name!r} is not a class in Foundry.Common.Models")
        return " | ".join(names)

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
                runtime = str(spec.get("Runtime") or "")
                if runtime not in RUNTIMES:
                    warnings.append(f"{DECL_FILE} Runtime: {runtime!r} is not one of {', '.join(RUNTIMES)}"
                                    if runtime else f"{DECL_FILE} Runtime: not declared")
                decl = Decl(
                    str(spec["name"]) if spec.get("name") else None,
                    self._types(spec.get("in"), f"{DECL_FILE} in", warnings),
                    self._types(spec.get("out"), f"{DECL_FILE} out", warnings),
                    str(spec.get("description") or "").strip(),
                    DECL_FILE,
                    warnings,
                    runtime if runtime in RUNTIMES else RUNTIMES[0],
                )
        else:
            decl = Decl(None, None, None, "", "none", [f"no {DECL_FILE} in this version"])
        self._decl_cache[key] = decl
        return decl

    async def scan_project(self, project: str) -> dict[str, ProcessorInfo]:
        proj = await self.gitlab.get_project(project)
        branch = proj["default_branch"]
        head = await self.gitlab.get_commit(project, branch)
        if head is None:
            return {}
        tree = await self.gitlab.list_tree(project, head["id"], recursive=True)
        build_dirs = {"target", "bin", "obj", "node_modules", ".venv"}
        blobs = [e for e in tree if e["type"] == "blob" and not build_dirs & set(e["path"].split("/"))]
        folders = {posixpath.dirname(e["path"]) for e in blobs if posixpath.basename(e["path"]) == DECL_FILE}
        infos = await asyncio.gather(*(self._crate(proj, head, path) for path in sorted(folders)))
        return {i.id: i for i in infos}

    async def _crate(self, proj: dict, repo_head: dict, path: str) -> ProcessorInfo:
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
                runtime=d.runtime,
            )
            for t, d in zip(tags, tag_decls)
        ]
        versions.sort(key=lambda v: semver_key(v.label), reverse=True)
        versions.append(Version(
            ref=head["id"], label=f"{proj['default_branch']}@{head['id'][:8]}", kind="branch", commit=head["id"],
            committed_date=head.get("committed_date"), input=head_decl.input, output=head_decl.output,
            source=head_decl.source, warnings=head_decl.warnings, web_url=f"{web}/-/tree/{head['id']}/{path}".rstrip("/"),
            runtime=head_decl.runtime,
        ))
        latest = versions[0]
        name = head_decl.name or (posixpath.basename(path) if path else None) or project
        return ProcessorInfo(
            id=f"{project}:{path}", project=project, path=path, name=name, description=head_decl.description,
            repo=proj["http_url_to_repo"], web_url=f"{web}/-/tree/{proj['default_branch']}/{path}".rstrip("/"),
            input=latest.input, output=latest.output, warnings=head_decl.warnings,
            latest=latest.ref, head=head["id"], versions=versions, runtime=latest.runtime,
        )
