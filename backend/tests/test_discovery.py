"""Transformer discovery against a fake GitLab (local git repos)."""

from __future__ import annotations

import pytest

from foundry_studio import demo
from foundry_studio.discovery import Discovery, semver_key

from .conftest import SKYWALKER

SCHEMAS = {"XmlPackets", "EncodedPackets", "Packets"}


def discovery(fake, foundry) -> Discovery:
    return Discovery(fake, lambda: SCHEMAS)


def commit(root, files: dict[str, str], message: str, tag: str | None = None):
    repo = root / SKYWALKER
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", message)
    if tag:
        demo._git(repo, "tag", tag)


@pytest.mark.anyio
async def test_discovers_csharp_transformers(fake, foundry):
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    assert set(found) == {f"{SKYWALKER}:XmlToJson", f"{SKYWALKER}:Base64Decoder"}
    x = found[f"{SKYWALKER}:XmlToJson"]
    assert (x.name, x.input, x.output, x.latest) == ("XmlToJson", "XmlPackets", "EncodedPackets", "XmlToJson/v0.4.2")
    assert not x.warnings and x.description.startswith("Converts XML")
    assert x.repo == "https://gitlab.com/yume02kki/skywalker.git"
    assert [v.kind for v in x.versions] == ["tag", "branch"]
    assert x.versions[-1].ref == x.head and len(x.head) == 40


@pytest.mark.anyio
async def test_transformer_yaml_wins_and_versions_sort_by_semver(demo_root, fake, foundry):
    commit(demo_root, {"XmlToJson/transformer.yaml":
                       "name: XmlToJson\nin: XmlPackets\nout: EncodedPackets\ndescription: XML to JSON\n"},
           "describe XmlToJson", tag="XmlToJson/v0.10.0")
    commit(demo_root, {"XmlToJson/x.cs": "// pre\n"}, "pre", tag="XmlToJson/v0.10.1-rc.1")
    commit(demo_root, {"XmlToJson/y.cs": "// other\n"}, "unrelated tag", tag="XmlToJsonExtra/v9.9.9")
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    x = found[f"{SKYWALKER}:XmlToJson"]
    assert x.description == "XML to JSON"
    assert [v.label for v in x.versions if v.kind == "tag"] == ["v0.10.1-rc.1", "v0.10.0", "v0.4.2"]


@pytest.mark.anyio
async def test_any_language_with_transformer_yaml(demo_root, fake, foundry):
    commit(demo_root, {
        "PacketEraser/transformer.yaml": "name: PacketEraser\nin: Packets\nout: Packets\ndescription: Erases data\n",
        "PacketEraser/PacketEraser.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        "PacketEraser/Dockerfile": "FROM scratch\n",
        "PacketEraser/bin/Release/transformer.yaml": "name: build output, not a transformer\n",
        "Shout/transformer.yaml": "name: Shout\nin: Packets\nout: Bogus\n",
        "Shout/pyproject.toml": "[project]\nname = \"shout\"\n",
    }, "C# and Python transformers")
    found = await discovery(fake, foundry).scan_project(SKYWALKER)
    t = found[f"{SKYWALKER}:PacketEraser"]
    assert t.name == "PacketEraser" and (t.input, t.output) == ("Packets", "Packets")
    assert not t.warnings
    shout = found[f"{SKYWALKER}:Shout"]
    assert shout.warnings == ["transformer.yaml out: 'Bogus' is not a schema in the catalog"]
    assert f"{SKYWALKER}:PacketEraser/bin/Release" not in found
    assert f"{SKYWALKER}:XmlToJson" in found


@pytest.mark.anyio
async def test_crate_version_is_last_commit_touching_it(demo_root, fake, foundry):
    before = (await discovery(fake, foundry).scan_project(SKYWALKER))[f"{SKYWALKER}:Base64Decoder"].head
    commit(demo_root, {"XmlToJson/README.md": "only XmlToJson changes\n"}, "touch XmlToJson")
    after = (await discovery(fake, foundry).scan_project(SKYWALKER))[f"{SKYWALKER}:Base64Decoder"].head
    assert before == after


def test_semver_order():
    assert semver_key("v1.2.3") > semver_key("v1.2.3-rc.1") > semver_key("v1.2.2")
