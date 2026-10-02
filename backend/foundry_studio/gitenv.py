"""Environment for the git processes deploy.py starts.

deploy.py shells out to `git clone` to vendor processor repos. We don't modify it to
pass credentials; instead the backend's own environment carries:

* a git credential helper that answers with $GITLAB_TOKEN at the moment git asks. The
  helper's text names the variable, never the value, so the token never ends up in a
  config value, a URL, a command line, or a log line;
* in demo mode, `url.<local repo>.insteadOf` rules so the gitlab.com URLs in manifests
  resolve to the local repositories.
"""

from __future__ import annotations

import os
from pathlib import Path

CREDENTIAL_HELPER = '!f() { test "$1" = get && printf "username=oauth2\\npassword=%s\\n" "$GITLAB_TOKEN"; }; f'


def add_git_config(env: dict, pairs: list[tuple[str, str]]) -> None:
    n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
    for key, value in pairs:
        env[f"GIT_CONFIG_KEY_{n}"] = key
        env[f"GIT_CONFIG_VALUE_{n}"] = value
        n += 1
    env["GIT_CONFIG_COUNT"] = str(n)


def configure(env: dict, *, gitlab_url: str, fake_root: Path | None = None, fake_projects: list[str] = (),
              web_base: str = "https://gitlab.com") -> None:
    """Mutates env (normally os.environ) so deploy.py's git clones can reach GitLab."""
    env["GITLAB_URL"] = gitlab_url
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    if fake_root is not None:
        add_git_config(env, [
            (f"url.{(fake_root / p).resolve()}.insteadOf", f"{web_base}/{p}.git") for p in fake_projects
        ])
    else:
        add_git_config(env, [(f"credential.{gitlab_url}.helper", CREDENTIAL_HELPER)])
