from __future__ import annotations

import os
from pathlib import Path

import pytest

from foundry_studio import demo, gitenv
from foundry_studio.app import Services
from foundry_studio.config import REPO_ROOT, Settings
from foundry_studio.fake_gitlab import FakeGitLab
from foundry_studio.foundry import Foundry

SCRIPTS_DIR = REPO_ROOT / "vendor" / "scripts"
XMLTOJSON = f"{demo.OPERATORS}/xmltojsonprocessor"
DECODE = f"{demo.OPERATORS}/decodingprocessor"
ISP = f"{demo.OPERATORS}/IspEnricher"
PROCESSOR_PROJECTS = [XMLTOJSON, DECODE, ISP]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def foundry() -> Foundry:
    return Foundry(SCRIPTS_DIR)


@pytest.fixture
def demo_root(tmp_path: Path, monkeypatch) -> Path:
    """Local stand-ins for configs and the processor repos, and a workspace."""
    root = demo.init(tmp_path / "gitlab")
    env = dict(os.environ)
    gitenv.configure(env, gitlab_url="https://gitlab.com", fake_root=root,
                     fake_projects=[p["path_with_namespace"] for p in FakeGitLab(root).projects_sync()])
    for k, v in env.items():
        if os.environ.get(k) != v:
            monkeypatch.setenv(k, v)
    return root


@pytest.fixture
def fake(demo_root: Path) -> FakeGitLab:
    return FakeGitLab(demo_root)


@pytest.fixture
def services(demo_root: Path, fake: FakeGitLab, foundry: Foundry) -> Services:
    return Services(Settings(scripts_dir=SCRIPTS_DIR), fake, foundry, fake_root=demo_root,
                    workspace=demo.workspace(demo_root))
