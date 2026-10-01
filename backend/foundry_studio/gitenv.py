"""Environment for the git and glab processes deploy.py starts.

deploy.py shells out to `git clone` (transformer repos, PipelineDeploys) and to
`glab mr create`. We don't modify it to pass credentials; instead the backend's own
environment carries:

* a git credential helper that answers with $GITLAB_TOKEN at the moment git asks. The
  helper's text names the variable, never the value, so the token never ends up in a
  config value, a URL, a command line, or a log line;
* in demo mode, `url.<local repo>.insteadOf` rules so the gitlab.com URLs in manifests
  resolve to the local repositories;
* a `glab` stand-in on PATH when glab isn't installed (or in demo mode) that opens the
  merge request through the GitLab API.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path

CREDENTIAL_HELPER = '!f() { test "$1" = get && printf "username=oauth2\\npassword=%s\\n" "$GITLAB_TOKEN"; }; f'


def add_git_config(env: dict, pairs: list[tuple[str, str]]) -> None:
    n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
    for key, value in pairs:
        env[f"GIT_CONFIG_KEY_{n}"] = key
        env[f"GIT_CONFIG_VALUE_{n}"] = value
        n += 1
    env["GIT_CONFIG_COUNT"] = str(n)


GLAB_SHIM = '''#!{python}
"""glab stand-in used by Foundry Studio: supports `glab mr create` only (what deploy.py runs)."""
import json, os, sys, urllib.parse, urllib.request

args = sys.argv[1:]
if args[:2] != ["mr", "create"]:
    sys.exit("foundry-studio glab shim: only `glab mr create` is supported")
opts, i = {{}}, 2
while i < len(args):
    a = args[i]
    if a in ("--yes", "--remove-source-branch"):
        opts[a[2:]] = True; i += 1
    else:
        opts[a[2:]] = args[i + 1]; i += 2
project = os.environ["STUDIO_GLAB_PROJECT"]
target = opts.get("target-branch") or os.environ.get("STUDIO_GLAB_TARGET", "main")
fake_root = os.environ.get("STUDIO_FAKE_GITLAB_ROOT")
if fake_root:
    sys.path.insert(0, {backend!r})
    from foundry_studio.fake_gitlab import FakeGitLab
    mr = FakeGitLab(fake_root).create_merge_request(
        project, opts["source-branch"], target, opts["title"], opts.get("description", ""))
else:
    base = os.environ.get("GITLAB_URL", "https://gitlab.com").rstrip("/")
    body = {{"source_branch": opts["source-branch"], "target_branch": target,
            "title": opts["title"], "description": opts.get("description", ""),
            "remove_source_branch": bool(opts.get("remove-source-branch"))}}
    req = urllib.request.Request(
        f"{{base}}/api/v4/projects/{{urllib.parse.quote(project, safe='')}}/merge_requests",
        data=json.dumps(body).encode(), method="POST",
        headers={{"PRIVATE-TOKEN": os.environ.get("GITLAB_TOKEN", ""), "Content-Type": "application/json"}})
    try:
        with urllib.request.urlopen(req) as r:
            mr = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"GitLab API {{e.code}}: {{e.read().decode()[:300]}}")
print(mr["web_url"])
'''


def write_glab_shim(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "glab"
    backend = str(Path(__file__).resolve().parents[1])
    path.write_text(GLAB_SHIM.format(python=sys.executable, backend=backend))
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def configure(env: dict, *, gitlab_url: str, deploys_project: str, shim_dir: Path, deploys_base: str = "main",
              fake_root: Path | None = None, fake_projects: list[str] = (), web_base: str = "https://gitlab.com") -> None:
    """Mutates env (normally os.environ) so deploy.py's child processes can reach GitLab."""
    env["STUDIO_GLAB_PROJECT"] = deploys_project
    env["STUDIO_GLAB_TARGET"] = deploys_base  # what glab defaults to: the project's base branch
    env["GITLAB_URL"] = gitlab_url
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    if fake_root is not None:
        env["STUDIO_FAKE_GITLAB_ROOT"] = str(fake_root)
        add_git_config(env, [
            (f"url.{(fake_root / p).resolve()}.insteadOf", f"{web_base}/{p}.git") for p in fake_projects
        ])
        use_shim = True
    else:
        env.pop("STUDIO_FAKE_GITLAB_ROOT", None)
        add_git_config(env, [(f"credential.{gitlab_url}.helper", CREDENTIAL_HELPER)])
        use_shim = shutil.which("glab", path=env.get("PATH")) is None
    if use_shim:
        write_glab_shim(shim_dir)
        env["PATH"] = f"{shim_dir}{os.pathsep}{env.get('PATH', '')}"
