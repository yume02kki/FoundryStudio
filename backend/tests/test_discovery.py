"""Transformer discovery against a fake GitLab (local git repos)."""

from __future__ import annotations

import pytest

from foundry_studio import demo
from foundry_studio.discovery import Discovery, semver_key

from .conftest import DECODE, XMLTOJSON

SCHEMAS = {"XmlPackets", "Packets", "EnrichedPackets"}


def discovery(fake) -> Discovery:
    return Discovery(fake, lambda: SCHEMAS)


def commit(repo, files: dict[str, str], message: str, tag: str | None = None):
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    demo._git(repo, "add", "-A")
    demo._git(repo, "commit", "-q", "-m", message)
    if tag:
        demo._git(repo, "tag", tag)


@pytest.mark.anyio
async def test_one_transformer_per_repo_root(fake):
    found = await discovery(fake).scan_project(XMLTOJSON)
    assert set(found) == {f"{XMLTOJSON}:"}
    x = found[f"{XMLTOJSON}:"]
    assert (x.name, x.input, x.output, x.latest, x.path) == ("XmlToJson", "XmlPackets", "Packets", "v1.0.0", "")
    assert not x.warnings and x.description.startswith("Converts XML")
    assert x.repo == f"https://gitlab.com/{XMLTOJSON}.git"
    assert [v.kind for v in x.versions] == ["tag", "branch"]
    assert x.versions[-1].ref == x.head and len(x.head) == 40


@pytest.mark.anyio
async def test_versions_sort_by_semver(demo_root, fake):
    repo = demo_root / DECODE
    commit(repo, {"a.cs": "// a\n"}, "a", tag="v1.10.0")
    commit(repo, {"b.cs": "// b\n"}, "b", tag="v1.10.1-rc.1")
    commit(repo, {"c.cs": "// c\n"}, "c", tag="not-a-version")
    found = (await discovery(fake).scan_project(DECODE))[f"{DECODE}:"]
    assert [v.label for v in found.versions if v.kind == "tag"] == ["v1.10.1-rc.1", "v1.10.0", "v1.0.0"]


@pytest.mark.anyio
async def test_folders_with_transformer_yaml_in_a_monorepo(demo_root, fake):
    repo = demo_root / "team-b" / "enrichers"
    repo.mkdir(parents=True)
    demo._git(repo, "init", "-q", "-b", "main")
    commit(repo, {
        "GeoTag/transformer.yaml": "name: GeoTag\nin: Packets\nout: Packets\n",
        "GeoTag/bin/Release/transformer.yaml": "name: build output, not a transformer\n",
        "Shout/transformer.yaml": "name: Shout\nin: Packets\nout: Bogus\n",
    }, "two transformers", tag="GeoTag/v0.1.0")
    found = await discovery(fake).scan_project("team-b/enrichers")
    assert set(found) == {"team-b/enrichers:GeoTag", "team-b/enrichers:Shout"}
    assert found["team-b/enrichers:GeoTag"].latest == "GeoTag/v0.1.0"
    assert found["team-b/enrichers:Shout"].warnings == ["transformer.yaml out: 'Bogus' is not a schema in foundry-models"]

    before = found["team-b/enrichers:GeoTag"].head
    commit(repo, {"Shout/README.md": "only Shout changes\n"}, "touch Shout")
    assert (await discovery(fake).scan_project("team-b/enrichers"))["team-b/enrichers:GeoTag"].head == before


@pytest.mark.anyio
async def test_no_known_schemas_flags_nothing(fake):
    found = await Discovery(fake, lambda: set()).scan_project(XMLTOJSON)
    assert found[f"{XMLTOJSON}:"].warnings == []


def test_semver_order():
    assert semver_key("v1.2.3") > semver_key("v1.2.3-rc.1") > semver_key("v1.2.2")
