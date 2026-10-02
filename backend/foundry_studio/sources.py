"""What a manifest refers to but doesn't contain, read through the GitLab API:

* connection profiles, `<kind>/<name>.yaml` in the configs repo the manifest names
  (`Configs: {Repo, Ref}`), e.g. kafka/prod;
* schemas, `schemas/*.yaml` in the configs repo, named as foundry-common's generator names the
  types (xml_packets.yaml -> XmlPackets).

Both are cached for a few seconds, so validating on every edit doesn't hit GitLab each time,
and a failed refresh keeps serving the last good copy. Studio never writes to either repo.
"""

from __future__ import annotations

import asyncio
import posixpath
import time
from pathlib import Path
from types import ModuleType

import yaml

from .gitlab import GitLab, GitLabError


class SourceError(Exception):
    pass


class Sources:
    def __init__(self, gitlab: GitLab, gitlab_url: str, manifest: ModuleType, configs_repo: str,
                 ttl: float = 30.0):
        self.gitlab = gitlab
        self.gitlab_url = gitlab_url.rstrip("/")
        self.m = manifest
        self.configs_repo = configs_repo
        self.ttl = ttl
        self._cache: dict[tuple, tuple[float, dict]] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}
        self.schema_names: set[str] = set()  # last known, for synchronous callers (discovery)

    def project_of(self, repo: str) -> str:
        """https://gitlab.com/foundry-platform/common/configs.git -> foundry-platform/common/configs (on this GitLab only)."""
        base = self.gitlab_url.split("://", 1)[-1]
        url = repo.strip().split("://", 1)[-1].removesuffix("/").removesuffix(".git")
        if not url.startswith(f"{base}/"):
            raise SourceError(f"{repo} isn't on {self.gitlab_url}")
        return url[len(base) + 1:]

    async def _cached(self, key: tuple, load) -> dict:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        async with self._locks.setdefault(key, asyncio.Lock()):
            hit = self._cache.get(key)
            if hit and time.monotonic() - hit[0] < self.ttl:
                return hit[1]
            try:
                value = await load()
            except (GitLabError, SourceError, OSError) as e:
                if hit:
                    return hit[1]  # stale beats nothing
                raise SourceError(str(e)) from None
            self._cache[key] = (time.monotonic(), value)
            return value

    async def _files(self, project: str, ref: str, wanted) -> tuple[str, dict[str, bytes]]:
        commit = await self.gitlab.get_commit(project, ref)
        if commit is None:
            raise SourceError(f"{project}@{ref} not found")
        tree = await self.gitlab.list_tree(project, commit["id"], recursive=True)
        paths = [e["path"] for e in tree if e["type"] == "blob" and wanted(e["path"])]
        blobs = await asyncio.gather(*(self.gitlab.get_file(project, p, commit["id"]) for p in paths))
        return commit["id"], {p: b for p, b in zip(paths, blobs) if b is not None}

    async def configs(self, repo: str | None = None, ref: str | None = None) -> dict:
        """{repo, ref, commit, files: {kind/name.yaml: bytes}, profiles: {kind/name: ConnectionSettings}}."""
        repo, ref = repo or self.configs_repo, ref or self.m.DEFAULT_REF

        async def load():
            def wanted(path):
                kind, _, name = path.partition("/")
                return kind in self.m.KINDS and "/" not in name and name.endswith(".yaml")

            commit, files = await self._files(self.project_of(repo), ref, wanted)
            profiles = {}
            for path, data in sorted(files.items()):
                try:
                    spec = yaml.safe_load(data) or {}
                except yaml.YAMLError:
                    spec = {}
                settings = spec.get("ConnectionSettings") if isinstance(spec, dict) else None
                profiles[path.removesuffix(".yaml")] = dict(settings) if isinstance(settings, dict) else {}
            return {"repo": repo, "ref": ref, "commit": commit, "files": files, "profiles": profiles}

        return await self._cached(("configs", repo, ref), load)

    async def schemas(self) -> dict:
        """{name: {file, format, fields, data}} from the configs repo's default branch."""
        async def load():
            name = self.project_of(self.configs_repo)
            project = await self.gitlab.get_project(name)
            _, files = await self._files(
                name, project["default_branch"],
                lambda p: posixpath.dirname(p) == self.m.SCHEMA_DIR and p.endswith(".yaml"))
            out = {}
            for path, data in sorted(files.items()):
                try:
                    spec = yaml.safe_load(data) or {}
                except yaml.YAMLError:
                    spec = {}
                spec = spec if isinstance(spec, dict) else {}
                fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
                out[self.m.schema_name(posixpath.basename(path).removesuffix(".yaml"))] = {
                    "file": path, "format": spec.get("format"),
                    "fields": {str(k): str(v) for k, v in fields.items()}, "data": data,
                }
            return out

        schemas = await self._cached(("schemas",), load)
        self.schema_names = set(schemas)
        return schemas

    @staticmethod
    def stage(configs: dict, dest: Path) -> Path:
        """Write a configs() snapshot as a checkout manifest.py can read."""
        for path, data in configs["files"].items():
            (dest / path).parent.mkdir(parents=True, exist_ok=True)
            (dest / path).write_bytes(data)
        return dest
