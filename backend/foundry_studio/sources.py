"""What a manifest refers to but doesn't contain, read through the GitLab API:

* connection profiles, `kafka/<name>.json` in the configRegistry repo the manifest names
  (`ConfigRegistry: {Repo, Ref}`), e.g. kafka/prod;
* type names: the types in schemaRegistry (`<Type>/metadata.yaml`), which manifests' AllowedTypes
  and operator.yaml's in/out name.

Both are cached for a few seconds, so validating on every edit doesn't hit GitLab each time,
and a failed refresh keeps serving the last good copy. Studio never writes to either repo.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from types import ModuleType

from .gitlab import GitLab, GitLabError


class SourceError(Exception):
    pass


class Sources:
    def __init__(self, gitlab: GitLab, gitlab_url: str, pipeline: ModuleType, configs_repo: str,
                 schema_registry_repo: str, ttl: float = 30.0):
        self.gitlab = gitlab
        self.gitlab_url = gitlab_url.rstrip("/")
        self.m = pipeline
        self.configs_repo = configs_repo
        self.schema_registry_repo = schema_registry_repo
        self.ttl = ttl
        self._cache: dict[tuple, tuple[float, dict]] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}
        self.type_names: set[str] = set()  # last known, for synchronous callers (discovery)

    def project_of(self, repo: str) -> str:
        """https://gitlab.com/foundry-platform/common/configRegistry.git -> foundry-platform/common/configRegistry (on this GitLab only)."""
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
        """{repo, ref, commit, files: {kind/name.json: bytes}, profiles: {kind/name: ConnectionSettings}}."""
        repo, ref = repo or self.configs_repo, ref or self.m.DEFAULT_REF

        async def load():
            def wanted(path):
                kind, _, name = path.partition("/")
                return kind == "kafka" and "/" not in name and name.endswith(".json")

            commit, files = await self._files(self.project_of(repo), ref, wanted)
            profiles = {}
            for path, data in sorted(files.items()):
                try:
                    spec = json.loads(data)
                except ValueError:
                    spec = {}
                settings = spec.get("ConnectionSettings") if isinstance(spec, dict) else None
                profiles[path.removesuffix(".json")] = dict(settings) if isinstance(settings, dict) else {}
            return {"repo": repo, "ref": ref, "commit": commit, "files": files, "profiles": profiles}

        return await self._cached(("configs", repo, ref), load)

    async def types(self) -> list[str]:
        """The type names in schemaRegistry (folders with a metadata.yaml), from its default branch."""
        async def load():
            name = self.project_of(self.schema_registry_repo)
            project = await self.gitlab.get_project(name)
            commit = await self.gitlab.get_commit(name, project["default_branch"])
            if commit is None:
                raise SourceError(f"{name}@{project['default_branch']} not found")
            tree = await self.gitlab.list_tree(name, commit["id"], recursive=True)
            meta = re.compile(rf"^([^/]+)/{re.escape(self.m.META_FILE)}$")
            return {"types": sorted(m.group(1) for e in tree if e["type"] == "blob" and (m := meta.match(e["path"])))}

        types = (await self._cached(("types",), load))["types"]
        self.type_names = set(types)
        return types

    @staticmethod
    def stage(configs: dict, dest: Path) -> Path:
        """Write a configs() snapshot as a checkout scripts' lib/pipeline.py can read."""
        for path, data in configs["files"].items():
            (dest / path).parent.mkdir(parents=True, exist_ok=True)
            (dest / path).write_bytes(data)
        return dest
