# skywalker

Transformers for foundry pipelines. Each directory is a standalone crate built
on the [foundry-transformer SDK](https://gitlab.com/yume02kki/foundry/-/tree/main/sdk):
one `Transformer` impl, `Dataset<In> -> Dataset<Out>`, run by `foundry_transformer::run`.

| Crate | In | Out |
|---|---|---|
| `XmlToJson` | `XmlPackets` | `EncodedPackets` |
| `Base64Decoder` | `EncodedPackets` | `Packets` |

Releases are tagged per transformer (`XmlToJson/vX.Y.Z`); a pipeline manifest
pins one with `Repo`, `Path` and `Ref`. `cargo test` in a crate runs its tests.

Each crate also declares its schemas in `transformer.yaml`, for pipeline tooling
(Foundry Studio reads it to type-check wiring):

```yaml
name: XmlToJson
in: XmlPackets          # Schema::NAME, as used in the pipeline manifest
out: EncodedPackets
description: Same record, different wire format (XML to JSON); data stays base64.
```

Keep `in`/`out` in step with `type In` / `type Out`; the runtime still checks the
real types against the topic schemas at startup.
