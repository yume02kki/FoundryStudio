"""Transformer discovery: find transformer crates in GitLab projects and list their versions.

A transformer is any folder with a `transformer.yaml` (name, in, out, description), in
any language (foundry's TRANSFORMERS.md). Rust crates whose Cargo.toml depends on
`foundry-transformer` count too even without one: their In/Out schemas are then inferred
from `type In = X;` / `type Out = Y;` in the crate's sources, mapping the Rust type to its
Schema::NAME via foundry-schemas, and the transformer carries a warning.
"""

from __future__ import annotations

import asyncio
import posixpath
import re
import tomllib
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

import yaml

from .gitlab import GitLab

DECL_FILE = "transformer.yaml"
FALLBACK_SOURCES = ("src/main.rs", "src/lib.rs")
_ASSOC_RE = {
    k: re.compile(rf"\btype\s+{k}\s*=\s*([A-Za-z_][\w:]*)\s*(?:<[^;]*>)?\s*;") for k in ("In", "Out")
}
_SEMVER_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")


def semver_key(version: str) -> tuple:
    m = _SEMVER_RE.match(version)
    if not m:
        return (-1, -1, -1, 0, version)
    major, minor, patch, pre = m.groups()
    # A release sorts above its pre-releases.
    return (int(major), int(minor), int(patch), 0 if pre else 1, pre or "")


def is_transformer_crate(cargo_toml: str) -> bool:
    try:
        data = tomllib.loads(cargo_toml)
    except tomllib.TOMLDecodeError:
        return bool(re.search(r"^\s*(\[dependencies\.)?foundry-transformer\b", cargo_toml, re.M))
    if "package" not in data:
        return False  # a bare workspace manifest
    tables = [data.get("dependencies") or {}]
    for target in (data.get("target") or {}).values():
        tables.append((target or {}).get("dependencies") or {})
    for deps in tables:
        for name, spec in deps.items():
            if name == "foundry-transformer":
                return True
            if isinstance(spec, dict) and spec.get("package") == "foundry-transformer":
                return True
    return False


def cargo_package_name(cargo_toml: str) -> str | None:
    try:
        return (tomllib.loads(cargo_toml).get("package") or {}).get("name")
    except tomllib.TOMLDecodeError:
        return None


@dataclass
class Decl:
    name: str | None
    input: str | None
    output: str | None
    description: str
    source: str  # "transformer.yaml" | "src/main.rs" | ... | "none"
    warnings: list[str] = field(default_factory=list)

    @property
    def inferred(self) -> bool:
        return self.source != DECL_FILE


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
    inferred: bool
    warnings: list[str]
    latest: str  # Ref of the newest version
    head: str  # commit SHA of the default branch
    versions: list[Version]

    def to_json(self) -> dict:
        return asdict(self)


class Discovery:
    def __init__(self, gitlab: GitLab, rust_schema_names: dict[str, str],
                 known_schemas: set[str] | Callable[[], set[str]]):
        self.gitlab = gitlab
        self.rust_schema_names = rust_schema_names
        self.known_schemas = known_schemas
        self._blob_cache: dict[tuple[str, str], str] = {}  # (project, blob sha) -> text
        self._decl_cache: dict[tuple[str, str, str], Decl] = {}  # (project, commit, path) -> Decl

    async def _blob(self, project: str, blob: str, path: str, ref: str) -> str:
        key = (project, blob)
        if key not in self._blob_cache:
            data = await self.gitlab.get_file(project, path, ref)
            self._blob_cache[key] = (data or b"").decode("utf-8", "replace")
        return self._blob_cache[key]

    def _schema(self, value, where: str, warnings: list[str]) -> str | None:
        if value is None:
            warnings.append(f"{where}: not declared")
            return None
        value = str(value)
        known = self.known_schemas() if callable(self.known_schemas) else self.known_schemas
        if value not in known:
            warnings.append(f"{where}: {value!r} is not a schema in the catalog")
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
            decl = await self._infer(project, join, commit)
        self._decl_cache[key] = decl
        return decl

    async def _infer(self, project: str, join, commit: str) -> Decl:
        for src in FALLBACK_SOURCES:
            raw = await self.gitlab.get_file(project, join(src), commit)
            if raw is None:
                continue
            text = raw.decode("utf-8", "replace")
            found = {k: rx.search(text) for k, rx in _ASSOC_RE.items()}
            if not all(found.values()):
                continue
            warnings = [f"no {DECL_FILE}; In/Out inferred from {src}"]
            schemas = {}
            for k, m in found.items():
                rust = m.group(1).rsplit("::", 1)[-1]
                schemas[k] = self.rust_schema_names.get(rust)
                if schemas[k] is None:
                    warnings.append(f"{src}: type {k} = {rust} is not a foundry-schemas type")
            return Decl(None, schemas["In"], schemas["Out"], "", src, warnings)
        return Decl(None, None, None, "", "none", [f"no {DECL_FILE}, and no `type In`/`type Out` found in src/"])

    async def scan_project(self, project: str) -> dict[str, TransformerInfo]:
        proj = await self.gitlab.get_project(project)
        branch = proj["default_branch"]
        head = await self.gitlab.get_commit(project, branch)
        if head is None:
            return {}
        tree = await self.gitlab.list_tree(project, head["id"], recursive=True)
        build_dirs = {"target", "bin", "obj", "node_modules", ".venv"}
        blobs = [e for e in tree if e["type"] == "blob" and not build_dirs & set(e["path"].split("/"))]
        # Any language: a folder with transformer.yaml. Rust crates without one are found by their Cargo.toml.
        declared = {posixpath.dirname(e["path"]) for e in blobs if posixpath.basename(e["path"]) == DECL_FILE}
        cargo = [e for e in blobs if posixpath.basename(e["path"]) == "Cargo.toml"]
        texts = await asyncio.gather(*(self._blob(project, e["id"], e["path"], head["id"]) for e in cargo))
        cargo_texts = {posixpath.dirname(e["path"]): t for e, t in zip(cargo, texts)}
        folders = declared | {path for path, t in cargo_texts.items() if is_transformer_crate(t)}
        infos = await asyncio.gather(*(self._crate(proj, head, path, cargo_texts.get(path)) for path in sorted(folders)))
        return {i.id: i for i in infos}

    async def _crate(self, proj: dict, repo_head: dict, path: str, cargo_text: str | None) -> TransformerInfo:
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
        name = head_decl.name or (posixpath.basename(path) if path else None) or (cargo_text and cargo_package_name(cargo_text)) or project
        return TransformerInfo(
            id=f"{project}:{path}", project=project, path=path, name=name, description=head_decl.description,
            repo=proj["http_url_to_repo"], web_url=f"{web}/-/tree/{proj['default_branch']}/{path}".rstrip("/"),
            input=latest.input, output=latest.output, inferred=head_decl.inferred, warnings=head_decl.warnings,
            latest=latest.ref, head=head["id"], versions=versions,
        )
