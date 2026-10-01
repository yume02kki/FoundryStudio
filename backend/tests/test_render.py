"""Acceptance criterion 2: a pipeline rebuilt in the UI renders byte-identically, and deploys as a no-op."""

from __future__ import annotations

import os
from pathlib import Path

from foundry_studio.pipelines import PipelineStore
from foundry_studio.validation import stage

from .conftest import DEPLOYS, FOUNDRY_DIR
from .test_manifest import scratch_graph


def tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def test_render_of_rebuilt_pipeline_is_byte_identical(foundry, demo_root, fake, tmp_path):
    store = PipelineStore(fake, foundry, tmp_path / "ws", DEPLOYS, "main")
    manifest = stage(scratch_graph(foundry, shuffle_keys=True), tmp_path / "staged", store.schema_resolver(None))

    foundry.deploy.render(FOUNDRY_DIR / "PipelineManifest.yaml", tmp_path / "original")
    foundry.deploy.render(manifest, tmp_path / "rebuilt")
    assert tree(tmp_path / "rebuilt") == tree(tmp_path / "original")

    # ...and equal to what is deployed in PipelineDeploys/SWpipeline.
    assert tree(tmp_path / "rebuilt") == tree(demo_root / DEPLOYS / "SWpipeline")


def test_deploying_rebuilt_pipeline_is_already_up_to_date(foundry, demo_root, fake, tmp_path):
    store = PipelineStore(fake, foundry, tmp_path / "ws", DEPLOYS, "main")
    result = store.deploy(scratch_graph(foundry), f"https://gitlab.com/{DEPLOYS}.git")
    assert result["status"] == "up_to_date", result["log"]
    assert "already up to date" in result["log"]


def test_deploying_a_change_opens_a_merge_request(foundry, demo_root, fake, tmp_path):
    store = PipelineStore(fake, foundry, tmp_path / "ws", DEPLOYS, "main")
    g = scratch_graph(foundry)
    g["nodes"][0]["sink"]["Topic"] = "raw.xml.v2"
    result = store.deploy(g, f"https://gitlab.com/{DEPLOYS}.git")
    assert result["status"] == "opened", result["log"]
    assert result["mrUrl"].endswith("/-/merge_requests/1")
    assert result["branch"].startswith("deploy/SWpipeline/")
    mr = fake.merge_request_sync(DEPLOYS, 1)
    assert mr["source_branch"] == result["branch"] and mr["head_pipeline"]["status"] == "running"
    # Nothing was pushed to main.
    assert fake.commit_sync(DEPLOYS, "main")["title"] == "deploy(SWpipeline)"


def test_save_writes_manifest_layout_and_schemas(foundry, fake, tmp_path):
    store = PipelineStore(fake, foundry, tmp_path / "ws", DEPLOYS, "main")
    layout = {"version": 1, "positions": {"InputSink": {"x": 0, "y": 0}}}
    out = store.save(scratch_graph(foundry), layout)
    folder = tmp_path / "ws" / "SWpipeline"
    assert Path(out["path"]) == folder / "manifest.yaml"
    assert (folder / "manifest.yaml").read_text() == (FOUNDRY_DIR / "PipelineManifest.yaml").read_text()
    assert (folder / "SWpipeline.layout.json").is_file()
    assert "positions" not in (folder / "manifest.yaml").read_text()
    # The draft folder is a valid deploy.py input on its own.
    foundry.deploy.load_pipeline(folder / "manifest.yaml")


def test_git_credentials_never_appear_in_config_values(tmp_path):
    from foundry_studio import gitenv

    env = {"PATH": os.environ["PATH"], "GITLAB_TOKEN": "glpat-SECRET"}
    gitenv.configure(env, gitlab_url="https://gitlab.com", deploys_project=DEPLOYS, shim_dir=tmp_path)
    assert "glpat-SECRET" not in "".join(v for k, v in env.items() if k != "GITLAB_TOKEN")
    assert any("credential.https://gitlab.com.helper" == v for v in env.values())
