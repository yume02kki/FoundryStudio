"""The small slice of the GitLab REST API Foundry Studio uses.

`GitLab` is the interface; `HttpGitLab` talks to gitlab.com (or a self-hosted
instance). `foundry_studio.fake_gitlab.FakeGitLab` implements the same interface on
local git repositories, for tests and the offline demo.
"""

from __future__ import annotations

import re

from typing import Protocol
from urllib.parse import quote

import httpx


class GitLabError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"GitLab API {status}: {message}")


class GitLab(Protocol):
    async def list_projects(self) -> list[dict]: ...
    async def get_project(self, project: str) -> dict: ...
    async def get_commit(self, project: str, ref: str) -> dict | None: ...
    async def last_commit(self, project: str, ref: str, path: str) -> dict | None: ...
    async def list_tree(self, project: str, ref: str, path: str = "", recursive: bool = True) -> list[dict]: ...
    async def get_file(self, project: str, path: str, ref: str) -> bytes | None: ...
    async def list_tags(self, project: str, search: str | None = None) -> list[dict]: ...
    async def list_events(self, project: str) -> list[dict]: ...
    async def aclose(self) -> None: ...


_DELETION_SCHEDULED = re.compile(r"-deletion_scheduled-\d+$")


def _pid(project: str) -> str:
    return quote(project, safe="")


class HttpGitLab:
    def __init__(self, base_url: str, token: str | None, timeout: float = 20.0):
        headers = {"PRIVATE-TOKEN": token} if token else {}
        self._client = httpx.AsyncClient(base_url=f"{base_url}/api/v4", headers=headers, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, url: str, params: dict | None = None, allow_404: bool = False):
        r = await self._client.get(url, params=params)
        if allow_404 and r.status_code == 404:
            return None
        if 300 <= r.status_code < 400:
            # A renamed project (e.g. one scheduled for deletion) answers its old path with a redirect.
            raise GitLabError(r.status_code, f"moved to {r.headers.get('location', '?')} (renamed, or scheduled for deletion?)")
        if r.status_code >= 400:
            # Never echo request headers; the body is GitLab's own error message.
            raise GitLabError(r.status_code, r.text[:200])
        return r

    async def _paged(self, url: str, params: dict | None = None, limit: int = 2000) -> list[dict]:
        params = {**(params or {}), "per_page": 100, "page": 1}
        out: list[dict] = []
        while True:
            r = await self._get(url, params)
            out.extend(r.json())
            nxt = r.headers.get("x-next-page")
            if not nxt or len(out) >= limit:
                return out
            params["page"] = int(nxt)

    async def list_projects(self) -> list[dict]:
        """Every non-archived project the token's user is a member of (directly or through a group),
        minus those scheduled for deletion (GitLab keeps them, renamed, for a grace period)."""
        projects = await self._paged("/projects", {"membership": "true", "archived": "false", "simple": "true",
                                                   "order_by": "last_activity_at"}, limit=5000)
        return [p for p in projects if not _DELETION_SCHEDULED.search(p.get("path_with_namespace", ""))]

    async def get_project(self, project: str) -> dict:
        return (await self._get(f"/projects/{_pid(project)}")).json()

    async def get_commit(self, project: str, ref: str) -> dict | None:
        r = await self._get(f"/projects/{_pid(project)}/repository/commits/{quote(ref, safe='')}", allow_404=True)
        return r.json() if r else None

    async def last_commit(self, project: str, ref: str, path: str) -> dict | None:
        params = {"ref_name": ref, "per_page": 1}
        if path:
            params["path"] = path
        r = await self._get(f"/projects/{_pid(project)}/repository/commits", params, allow_404=True)
        commits = r.json() if r else []
        return commits[0] if commits else None

    async def list_tree(self, project: str, ref: str, path: str = "", recursive: bool = True) -> list[dict]:
        params = {"ref": ref, "recursive": str(recursive).lower()}
        if path:
            params["path"] = path
        try:
            return await self._paged(f"/projects/{_pid(project)}/repository/tree", params)
        except GitLabError as e:
            if e.status == 404:
                return []
            raise

    async def get_file(self, project: str, path: str, ref: str) -> bytes | None:
        r = await self._get(
            f"/projects/{_pid(project)}/repository/files/{quote(path, safe='')}/raw", {"ref": ref}, allow_404=True
        )
        return r.content if r else None

    async def list_tags(self, project: str, search: str | None = None) -> list[dict]:
        params = {"order_by": "updated"}
        if search:
            params["search"] = search
        return await self._paged(f"/projects/{_pid(project)}/repository/tags", params)

    async def list_events(self, project: str) -> list[dict]:
        r = await self._get(f"/projects/{_pid(project)}/events", {"per_page": 50})
        return r.json()
