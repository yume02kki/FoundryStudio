"""Transformer discovery against a fake GitLab (local git repos)."""

from __future__ import annotations

import pytest

from foundry_studio import demo
from foundry_studio.discovery import Discovery, is_transformer_crate, semver_key

from .conftest import SKYWALKER


def discovery(fake, foundry) -> Discovery:
    return Discovery(fake, foundry.rust_schema_names, set(foundry.schemas))


def commit(root, files: dict[str, str], message: str, tag: str | None = None):
    repo = root / SKYWALKER
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", message)
    if tag:
        demo._git(repo, "tag", tag)


def test_schema_names_come_from_foundry_schemas(foundry):
    assert foundry.rust_schema_names == {
        "XmlPacket": "XmlPackets", "EncodedPacket": "EncodedPackets", "Packet": "Packets",
    }
    assert list(foundry.schemas) == ["XmlPackets", "EncodedPackets", "Packets"]


@pytest.mark.anyio
async def test_discovers_crates_with_fallback_warning(fake, foundry):
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    assert set(found) == {f"{SKYWALKER}:XmlToJson", f"{SKYWALKER}:Base64Decoder"}
    x = found[f"{SKYWALKER}:XmlToJson"]
    assert (x.name, x.input, x.output, x.latest) == ("XmlToJson", "XmlPackets", "EncodedPackets", "XmlToJson/v0.4.2")
    assert x.inferred and "inferred from src/main.rs" in x.warnings[0]
    assert x.repo == "https://gitlab.com/yume02kki/skywalker.git"
    assert [v.kind for v in x.versions] == ["tag", "branch"]
    assert x.versions[-1].ref == x.head and len(x.head) == 40


@pytest.mark.anyio
async def test_transformer_yaml_wins_and_versions_sort_by_semver(demo_root, fake, foundry):
    commit(demo_root, {"XmlToJson/transformer.yaml":
                       "name: XmlToJson\nin: XmlPackets\nout: EncodedPackets\ndescription: XML to JSON\n"},
           "declare XmlToJson", tag="XmlToJson/v0.10.0")
    commit(demo_root, {"XmlToJson/src/x.rs": "// pre\n"}, "pre", tag="XmlToJson/v0.10.1-rc.1")
    commit(demo_root, {"XmlToJson/src/y.rs": "// other\n"}, "unrelated tag", tag="XmlToJsonExtra/v9.9.9")
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    x = found[f"{SKYWALKER}:XmlToJson"]
    assert not x.inferred and x.description == "XML to JSON"
    assert [v.label for v in x.versions if v.kind == "tag"] == ["v0.10.1-rc.1", "v0.10.0", "v0.4.2"]
    old = next(v for v in x.versions if v.label == "v0.4.2")
    assert old.source == "src/main.rs" and old.warnings  # that tag predates transformer.yaml


@pytest.mark.anyio
async def test_unknown_types_and_non_transformer_crates(demo_root, fake, foundry):
    files = demo.crate_files("Custom", "Mystery", "Packets")
    commit(demo_root, {f"tools/Custom/{k}": v for k, v in files.items()} | {
        "tools/cli/Cargo.toml": '[package]\nname = "cli"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
        "Cargo.toml": '[workspace]\nmembers = ["XmlToJson"]\n',
    }, "more crates")
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    assert f"{SKYWALKER}:tools/cli" not in found and f"{SKYWALKER}:" not in found
    custom = found[f"{SKYWALKER}:tools/Custom"]
    assert custom.input is None and custom.output == "Packets"
    assert any("Mystery is not a foundry-schemas type" in w for w in custom.warnings)


@pytest.mark.anyio
async def test_crate_version_is_last_commit_touching_it(demo_root, fake, foundry):
    before = (await discovery(fake, foundry).scan_project(SKYWALKER))[f"{SKYWALKER}:Base64Decoder"].head
    commit(demo_root, {"XmlToJson/README.md": "only XmlToJson changes\n"}, "touch XmlToJson")
    after = (await discovery(fake, foundry).scan_project(SKYWALKER))[f"{SKYWALKER}:Base64Decoder"].head
    assert before == after


def test_cargo_detection():
    assert is_transformer_crate('[package]\nname="a"\n[dependencies]\nfoundry-transformer = { path = "x" }\n')
    assert is_transformer_crate('[package]\nname="a"\n[dependencies.foundry-transformer]\ngit = "x"\n')
    assert is_transformer_crate('[package]\nname="a"\n[dependencies]\nsdk = { package = "foundry-transformer" }\n')
    assert not is_transformer_crate('[package]\nname="a"\n[dev-dependencies]\nfoundry-transformer = "1"\n')
    assert not is_transformer_crate('[workspace]\n[workspace.dependencies]\nfoundry-transformer = "1"\n')
    assert semver_key("v1.2.3") > semver_key("v1.2.3-rc.1") > semver_key("v1.2.2")
