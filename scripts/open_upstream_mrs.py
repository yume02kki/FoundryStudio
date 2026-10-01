#!/usr/bin/env python3
"""Open the upstream merge request Foundry Studio relies on.

    GITLAB_TOKEN=... python3 scripts/open_upstream_mrs.py          # dry run: prepare and show
    GITLAB_TOKEN=... python3 scripts/open_upstream_mrs.py --yes    # push branches, open MRs

* foundry: upstream/foundry/*.patch -> branch studio/structured-errors

Each change goes to a new branch and a merge request; nothing is ever pushed to main.
The token needs write_repository (push) and api (open the MR). It reaches git through a
credential helper that reads $GITLAB_TOKEN, so it never appears in a URL or on disk.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
GITLAB = os.environ.get("GITLAB_URL", "https://gitlab.com").rstrip("/")
HELPER = '!f() { test "$1" = get && printf "username=oauth2\\npassword=%s\\n" "$GITLAB_TOKEN"; }; f'

CHANGES = [
    {"project": "yume02kki/foundry", "branch": "studio/structured-errors", "dir": UPSTREAM / "foundry"},
]


def git(*args: str, cwd: Path | None = None) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    res = subprocess.run(["git", "-c", f"credential.{GITLAB}.helper=", "-c", f"credential.{GITLAB}.helper={HELPER}", *args],
                         cwd=cwd, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"git {args[0]} failed: {res.stderr.strip()}")
    return res.stdout.strip()


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{GITLAB}/api/v4{path}", method=method, data=json.dumps(body).encode() if body else None,
        headers={"PRIVATE-TOKEN": os.environ["GITLAB_TOKEN"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"GitLab API {method} {path}: {e.code} {e.read().decode()[:300]}")


def prepare(change: dict, work: Path) -> Path:
    repo = work / change["project"].split("/")[1]
    git("clone", "--quiet", f"{GITLAB}/{change['project']}.git", str(repo))
    if git("ls-remote", "--heads", "origin", change["branch"], cwd=repo):
        sys.exit(f"{change['project']}: branch {change['branch']} already exists; delete it or merge its MR first")
    git("checkout", "--quiet", "-b", change["branch"], "origin/HEAD", cwd=repo)
    for patch in sorted(change["dir"].glob("*.patch")):
        git("am", "--quiet", "--3way", str(patch), cwd=repo)
    return repo


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yes", action="store_true", help="push the branches and open the merge requests")
    args = ap.parse_args()
    if not os.environ.get("GITLAB_TOKEN"):
        sys.exit("GITLAB_TOKEN is not set")

    with tempfile.TemporaryDirectory() as tmp:
        for change in CHANGES:
            repo = prepare(change, Path(tmp))
            description = (change["dir"] / "MERGE_REQUEST.md").read_text()
            title = description.splitlines()[0].lstrip("# ").strip()
            print(f"== {change['project']}: {change['branch']} -> default branch")
            print(git("show", "--stat", "--format=%s", "HEAD", cwd=repo))
            if not args.yes:
                print("(dry run: pass --yes to push and open the merge request)\n")
                continue
            git("push", "--quiet", "-u", "origin", change["branch"], cwd=repo)
            project = urllib.parse.quote(change["project"], safe="")
            target = api("GET", f"/projects/{project}")["default_branch"]
            mr = api("POST", f"/projects/{project}/merge_requests", {
                "source_branch": change["branch"], "target_branch": target, "title": title,
                "description": description, "remove_source_branch": True,
            })
            print(f"opened {mr['web_url']}\n")


if __name__ == "__main__":
    main()
