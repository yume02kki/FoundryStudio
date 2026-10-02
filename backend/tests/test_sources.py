"""Connection profiles and schemas, read through the GitLab API and cached."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from foundry_studio import demo
from foundry_studio.app import create_app
from foundry_studio.sources import SourceError, Sources


def sources(fake, foundry, ttl=30.0) -> Sources:
    return Sources(fake, "https://gitlab.com", foundry.manifest, "https://gitlab.com/foundry-common/configs.git",
                   ttl=ttl)


@pytest.mark.anyio
async def test_profiles_and_schemas(fake, foundry):
    s = sources(fake, foundry)
    configs = await s.configs()
    assert configs["profiles"]["kafka/prod"] == {"Brokers": "kafka-internal:9092", "SecurityProtocol": "SASL_SSL",
                                                 "SaslMechanism": "SCRAM-SHA-512", "SecretRef": "kafka-internal-creds"}
    assert set(configs["files"]) == {"kafka/prod.yaml", "kafka/load.yaml"} and len(configs["commit"]) == 40
    schemas = await s.schemas()
    assert set(schemas) == {"XmlPackets", "Packets", "EnrichedPackets"} == s.schema_names
    assert schemas["EnrichedPackets"]["fields"]["ISP"] == "string" and schemas["XmlPackets"]["format"] == "xml"


@pytest.mark.anyio
async def test_cache_and_refresh(demo_root, fake, foundry):
    s = sources(fake, foundry)
    before = await s.configs()
    (demo_root / demo.CONFIGS / "kafka" / "dev.yaml").write_text("ConnectionSettings:\n  Brokers: dev:9092\n")
    demo._git(demo_root / demo.CONFIGS, "add", "-A")
    demo._git(demo_root / demo.CONFIGS, "commit", "-qm", "dev")
    assert await s.configs() is before  # cached
    s.ttl = 0
    assert "kafka/dev" in (await s.configs())["profiles"]


@pytest.mark.anyio
async def test_errors(fake, foundry):
    s = sources(fake, foundry)
    with pytest.raises(SourceError, match="isn't on https://gitlab.com"):
        await s.configs("https://github.com/x/configs.git")
    with pytest.raises(SourceError, match="not found"):
        await s.configs(ref="v9")
    assert s.project_of("https://gitlab.com/a/b.git/") == "a/b"


def test_catalog_endpoint(services):
    with TestClient(create_app(services, start_watcher=False)) as c:
        cat = c.get("/api/catalog").json()
        assert list(cat["profiles"]) == ["kafka/load", "kafka/prod"] and cat["errors"] == {}
        assert cat["configs"]["repo"] == "https://gitlab.com/foundry-common/configs.git"
        assert "data" not in cat["schemas"]["Packets"]
        assert "configs" in c.get("/api/catalog?ref=nope").json()["errors"]
