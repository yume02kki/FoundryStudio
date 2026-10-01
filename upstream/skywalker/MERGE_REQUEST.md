# Declare each transformer's schemas in transformer.yaml

**Target:** `yume02kki/skywalker`, branch `studio/transformer-yaml` → `main`.
**Files:** `XmlToJson/transformer.yaml`, `Base64Decoder/transformer.yaml`.

## Why

Foundry Studio discovers transformer crates (folders whose `Cargo.toml` depends on
`foundry-transformer`) and needs each one's In/Out schema to type-check wiring in the UI.
Today those only exist as Rust (`type In = XmlPacket;`), which Studio has to parse and map
through foundry-schemas, and it marks transformers found that way with a warning. The
convention adds one small file per crate:

```yaml
name: XmlToJson
in: XmlPackets        # Schema::NAME, as used in the pipeline manifest
out: EncodedPackets
description: …
```

## Effects to be aware of

- No Rust code, Cargo files or Dockerfiles change; the runtime ignores the file.
- deploy.py vendors the whole crate folder, so **new** tags cut after this merge get a
  different content hash (and image tag) than an otherwise identical tag without the file.
  Existing tags such as `XmlToJson/v0.4.2` are unaffected, so deployed pipelines don't change.
- The declared names must match `type In` / `type Out`; the runtime still checks the real
  types against the topic schemas at startup.
