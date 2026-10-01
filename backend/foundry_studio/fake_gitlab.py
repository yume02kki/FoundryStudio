"""A GitLab look-alike backed by local git repositories.

Used by the tests and by the offline demo (`STUDIO_FAKE_GITLAB=demo`). Every project is
a normal git repository at `<root>/<namespace>/<name>`. Events are synthesised by
diffing the repository's refs between calls, so committing or tagging in one of those
repos behaves like pushing to GitLab.
"""

from __future__ import annotations

import asyncio
import hashlib
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FakeGitLab:
    def __init__(self, root: Path, clone_base: str = "https://gitlab.com", web_base: str = "https://gitlab.example/demo"):
        self.root = Path(root)
        # Clone URLs look like gitlab.com's so manifests match the real ones (git's insteadOf
        # maps them to the local repos); browser links go to an obviously fake host.
        self.clone_base = clone_base
        self.web_base = web_base
        self._refs: dict[str, dict[str, str]] = {}
        self._events: dict[str, list[dict]] = {}
        self._event_id = 0

    # -- helpers ---------------------------------------------------------------------- #

    def repo(self, project: str) -> Path:
        p = self.root / project
        if not (p / ".git").exists() and not (p / "HEAD").exists():
            from .gitlab import GitLabError

            raise GitLabError(404, f"project {project} not found")
        return p

    def _git(self, project: str, *args: str, check: bool = True) -> str:
        res = subprocess.run(["git", *args], cwd=self.repo(project), capture_output=True)
        if check and res.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {res.stderr.decode().strip()}")
        return res.stdout.decode() if res.returncode == 0 else ""

    def _git_bytes(self, project: str, *args: str) -> bytes | None:
        res = subprocess.run(["git", *args], cwd=self.repo(project), capture_output=True)
        return res.stdout if res.returncode == 0 else None

    def _snapshot(self, project: str) -> dict[str, str]:
        out = self._git(project, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags")
        return dict(line.split("\0") for line in out.splitlines() if line)

    # -- sync implementations ----------------------------------------------------------- #

    def project_sync(self, project: str) -> dict:
        repo = self.repo(project)
        branch = self._git(project, "symbolic-ref", "--short", "HEAD").strip() or "main"
        last = self._git(project, "log", "-1", "--format=%cI", "--all", check=False).strip()
        return {
            "id": int(hashlib.sha1(project.encode()).hexdigest()[:8], 16),
            "path_with_namespace": project,
            "name": project.rsplit("/", 1)[-1],
            "default_branch": branch,
            "http_url_to_repo": f"{self.clone_base}/{project}.git",
            "web_url": f"{self.web_base}/{project}",
            "last_activity_at": last or _now(),
            "local_path": str(repo),
        }

    def commit_sync(self, project: str, ref: str) -> dict | None:
        out = self._git(project, "log", "-1", "--format=%H%x00%cI%x00%s", f"{ref}^{{commit}}", "--", check=False)
        if not out.strip():
            return None
        sha, date, title = out.strip().split("\0", 2)
        return {"id": sha, "short_id": sha[:8], "committed_date": date, "title": title,
                "web_url": f"{self.web_base}/{project}/-/commit/{sha}"}

    def last_commit_sync(self, project: str, ref: str, path: str) -> dict | None:
        out = self._git(project, "log", "-1", "--format=%H", ref, "--", path or ".", check=False).strip()
        return self.commit_sync(project, out) if out else None

    def tree_sync(self, project: str, ref: str, path: str = "", recursive: bool = True) -> list[dict]:
        args = ["ls-tree", "--full-tree"] + (["-r", "-t"] if recursive else []) + [ref]
        if path:
            args += ["--", path.rstrip("/") + "/"]
        out = self._git(project, *args, check=False)
        entries = []
        for line in out.splitlines():
            meta, name = line.split("\t", 1)
            _, kind, sha = meta.split()
            entries.append({"id": sha, "name": name.rsplit("/", 1)[-1], "type": kind, "path": name})
        return entries

    def file_sync(self, project: str, path: str, ref: str) -> bytes | None:
        return self._git_bytes(project, "show", f"{ref}:{path}")

    def tags_sync(self, project: str, search: str | None = None) -> list[dict]:
        out = self._git(
            project, "for-each-ref", "--sort=-creatordate",
            "--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)", "refs/tags",
        )
        tags = []
        for line in out.splitlines():
            name, obj, peeled, date = line.split("\0")
            if search:
                if search.startswith("^") and not name.startswith(search[1:]):
                    continue
                if not search.startswith("^") and search not in name:
                    continue
            sha = peeled or obj
            tags.append({"name": name, "commit": {"id": sha, "committed_date": date, "created_at": date}})
        return tags

    def events_sync(self, project: str) -> list[dict]:
        current = self._snapshot(project)
        previous = self._refs.get(project)
        self._refs[project] = current
        events = self._events.setdefault(project, [])
        if previous is not None:
            for ref in sorted(previous.keys() | current.keys()):
                before, after = previous.get(ref), current.get(ref)
                if before == after:
                    continue
                kind = "tag" if ref.startswith("refs/tags/") else "branch"
                short = ref.split("/", 2)[2]
                action = "created" if before is None else "removed" if after is None else "pushed"
                self._event_id += 1
                events.insert(0, {
                    "id": self._event_id,
                    "action_name": {"created": "pushed new", "removed": "deleted", "pushed": "pushed to"}[action],
                    "created_at": _now(),
                    "push_data": {"ref_type": kind, "ref": short, "action": action,
                                  "commit_from": before, "commit_to": after},
                })
        return events[:50]

    def projects_sync(self) -> list[dict]:
        out = []
        for ns in sorted(p for p in self.root.iterdir() if p.is_dir()) if self.root.is_dir() else []:
            for repo in sorted(p for p in ns.iterdir() if p.is_dir()):
                if (repo / ".git").exists() or (repo / "HEAD").is_file():
                    out.append(self.project_sync(f"{ns.name}/{repo.name}"))
        return out

    # -- async GitLab interface --------------------------------------------------------- #

    async def list_projects(self) -> list[dict]:
        return await asyncio.to_thread(self.projects_sync)

    async def get_project(self, project: str) -> dict:
        return await asyncio.to_thread(self.project_sync, project)

    async def get_commit(self, project: str, ref: str) -> dict | None:
        return await asyncio.to_thread(self.commit_sync, project, ref)

    async def last_commit(self, project: str, ref: str, path: str) -> dict | None:
        return await asyncio.to_thread(self.last_commit_sync, project, ref, path)

    async def list_tree(self, project: str, ref: str, path: str = "", recursive: bool = True) -> list[dict]:
        return await asyncio.to_thread(self.tree_sync, project, ref, path, recursive)

    async def get_file(self, project: str, path: str, ref: str) -> bytes | None:
        return await asyncio.to_thread(self.file_sync, project, path, ref)

    async def list_tags(self, project: str, search: str | None = None) -> list[dict]:
        return await asyncio.to_thread(self.tags_sync, project, search)

    async def list_events(self, project: str) -> list[dict]:
        return await asyncio.to_thread(self.events_sync, project)

    async def aclose(self) -> None:
        pass
