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


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def foundry() -> Foundry:
    return Foundry(FOUNDRY_DIR)


@pytest.fixture
def demo_root(tmp_path: Path, monkeypatch) -> Path:
    """A local stand-in for skywalker, a workspace and a Runner: none target, wired up the way the app does it."""
    root = demo.init(tmp_path / "gitlab", FOUNDRY_DIR)
    env = dict(os.environ)
    gitenv.configure(env, gitlab_url="https://gitlab.com", fake_root=root, fake_projects=[SKYWALKER])
    for k, v in env.items():
        if os.environ.get(k) != v:
            monkeypatch.setenv(k, v)
    return root


@pytest.fixture
def fake(demo_root: Path) -> FakeGitLab:
    return FakeGitLab(demo_root)


def legacy_rust_crate(name: str, input: str, output: str) -> dict[str, str]:
    """A Rust crate from before transformer.yaml: its types are only in the code."""
    rust = {"XmlPackets": "XmlPacket", "EncodedPackets": "EncodedPacket", "Packets": "Packet"}
    rin, rout = rust.get(input, input), rust.get(output, output)
    return {
        "Cargo.toml": f'[package]\nname = "{name.lower()}"\nversion = "0.1.0"\n\n'
                      '[dependencies]\nfoundry-transformer = { git = "https://gitlab.com/yume02kki/foundry.git" }\n',
        "Cargo.lock": "version = 4\n",
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.89"\n',
        "Dockerfile": "FROM scratch\n",
        "src/main.rs": f"struct {name};\nimpl Transformer for {name} {{\n    type In = {rin};\n    type Out = {rout};\n}}\n",
    }
