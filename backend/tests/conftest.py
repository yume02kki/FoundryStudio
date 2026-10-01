from __future__ import annotations

import os
from pathlib import Path

import pytest

from foundry_studio import demo, gitenv
from foundry_studio.config import REPO_ROOT
from foundry_studio.fake_gitlab import FakeGitLab
from foundry_studio.foundry import Foundry

FOUNDRY_DIR = REPO_ROOT / "vendor" / "foundry"
SKYWALKER = demo.SKYWALKER
DEPLOYS = demo.DEPLOYS


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def foundry() -> Foundry:
    return Foundry(FOUNDRY_DIR)


@pytest.fixture
def demo_root(tmp_path: Path, monkeypatch) -> Path:
    """Local stand-ins for skywalker and PipelineDeploys, wired up the way the app does it."""
    root = demo.init(tmp_path / "gitlab", FOUNDRY_DIR)
    env = dict(os.environ)
    gitenv.configure(env, gitlab_url="https://gitlab.com", deploys_project=DEPLOYS, shim_dir=tmp_path / "bin",
                     fake_root=root, fake_projects=[SKYWALKER, DEPLOYS])
    for k, v in env.items():
        if os.environ.get(k) != v:
            monkeypatch.setenv(k, v)
    return root


@pytest.fixture
def fake(demo_root: Path) -> FakeGitLab:
    return FakeGitLab(demo_root)
