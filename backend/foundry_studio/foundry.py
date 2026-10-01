"""Access to the pinned foundry checkout: deploy.py as a library, and the schema catalog.

deploy.py is the single source of truth for validation. Nothing here re-implements a
rule; we only import it and attach each error to the node or edge it talks about.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from types import ModuleType

import yaml

_SCHEMA_IMPL_RE = re.compile(
    r"impl\s+Schema\s+for\s+(\w+)\s*\{.*?const\s+NAME\s*:\s*&(?:'static\s+)?str\s*=\s*\"([^\"]+)\"",
    re.S,
)

# Mirrors the "where" prefixes deploy.py puts on its messages. deploy.locate() is used
# instead when the pinned foundry provides it (see upstream/foundry).
_EDGE_RE = re.compile(r"^Relation '(.+?) -> (.+?)'")
_CYCLE_RE = re.compile(r"^Relation: cycle detected among (.+)$")
_TRANSFORMER_RE = re.compile(r"^Transformers\.([^.:\s]+)")
_SINK_RE = re.compile(r"^(InputSink|OutputSink)\b(?:\.([^:]+))?")


def locate(message: str) -> dict:
    """What a deploy.py error is about: {message, node, edge, nodes, field}."""
    issue: dict = {"message": message, "node": None, "edge": None, "nodes": [], "field": None}
    if m := _EDGE_RE.match(message):
        issue["edge"] = [m.group(1), m.group(2)]
        issue["nodes"] = [m.group(1), m.group(2)]
    elif m := _CYCLE_RE.match(message):
        issue["nodes"] = [n.strip() for n in m.group(1).split(",")]
    elif m := _TRANSFORMER_RE.match(message):
        issue["node"] = m.group(1)
        rest = message[len(m.group(0)):]
        if rest.startswith(".") and (f := re.match(r"\.([^:]+):", rest)):
            issue["field"] = f.group(1)
    elif m := _SINK_RE.match(message):
        issue["node"] = m.group(1)
        issue["field"] = m.group(2)
    elif message.startswith(("Defaults", "Name", "Schemas", "manifest", "Relation")):
        issue["field"] = message.split(":", 1)[0]
    if issue["node"] and not issue["nodes"]:
        issue["nodes"] = [issue["node"]]
    return issue


@dataclass
class SchemaInfo:
    name: str
    file: str  # relative to the foundry checkout, e.g. schemas/xml_packets.xsd
    rust_type: str | None


class Foundry:
    def __init__(self, root: Path):
        self.root = root
        if not (root / "deploy.py").is_file():
            raise RuntimeError(
                f"{root}/deploy.py not found; run `git submodule update --init` (foundry is pinned in vendor/foundry)"
            )

    @cached_property
    def deploy(self) -> ModuleType:
        spec = importlib.util.spec_from_file_location("foundry_deploy", self.root / "deploy.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["foundry_deploy"] = module
        spec.loader.exec_module(module)
        return module

    @cached_property
    def commit(self) -> str | None:
        try:
            return subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True, check=True
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    @cached_property
    def example_manifest(self) -> dict:
        return yaml.safe_load((self.root / "PipelineManifest.yaml").read_text())

    @cached_property
    def rust_schema_names(self) -> dict[str, str]:
        """Rust type -> Schema::NAME, from foundry-schemas (e.g. XmlPacket -> XmlPackets)."""
        src = (self.root / "sdk" / "foundry-schemas" / "src" / "lib.rs").read_text()
        return {m.group(1): m.group(2) for m in _SCHEMA_IMPL_RE.finditer(src)}

    @cached_property
    def schemas(self) -> dict[str, SchemaInfo]:
        """The schema catalog, in manifest order (the example manifest's Schemas section)."""
        by_name = {v: k for k, v in self.rust_schema_names.items()}
        return {
            name: SchemaInfo(name, str(file), by_name.get(name))
            for name, file in (self.example_manifest.get("Schemas") or {}).items()
        }

    def schema_file(self, rel: str) -> Path | None:
        p = (self.root / rel).resolve()
        return p if p.is_file() and self.root in p.parents else None

    def locate(self, message: str) -> dict:
        upstream = getattr(self.deploy, "locate", None)
        return upstream(message) if callable(upstream) else locate(message)
