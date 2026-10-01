"""Access to the pinned foundry checkout: deploy.py as a library, and its example files.

deploy.py is the single source of truth for validation and deploys. Nothing here
re-implements a rule; we only import it and attach each error to the node or edge it
talks about.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from functools import cached_property
from pathlib import Path
from types import ModuleType

_SCHEMA_IMPL_RE = re.compile(
    r"impl\s+Schema\s+for\s+(\w+)\s*\{.*?const\s+NAME\s*:\s*&(?:'static\s+)?str\s*=\s*\"([^\"]+)\"",
    re.S,
)

DATASET = "dataset:"  # node id prefix of a dataset on the canvas


def dataset_node(name: str) -> str:
    return f"{DATASET}{name}"


# The "where" prefixes deploy.py puts on its messages.
_TRANSFORMER_RE = re.compile(r"^Transformers\.([^.:\s]+)(?:\.([A-Za-z]+))?:")
_INPUT_RE = re.compile(r"^Transformers\.([^.:\s]+)\.Inputs: (?:unknown dataset '([^']+)'|(\S+) (?:carries|is listed))")
_OUTPUT_RE = re.compile(r"^Transformers\.([^.:\s]+)\.Output: (?:unknown dataset '([^']+)'|\S+ (?:emits \S+ but (\S+) carries|reads and writes (\S+)))")
_CYCLE_RE = re.compile(r"^Transformers: cycle detected among (.+)$")
_DATASET_RE = re.compile(r"^Datasets\.(.+?)(?:\.(Cluster|Schema))?: ")


def locate(message: str) -> dict:
    """What a deploy.py error is about: {message, node, edge, nodes, field}."""
    issue: dict = {"message": message, "node": None, "edge": None, "nodes": [], "field": None}
    if m := _INPUT_RE.match(message):
        t, ds = m.group(1), m.group(2) or m.group(3)
        issue["edge"] = [dataset_node(ds), t]
        issue["nodes"] = [dataset_node(ds), t]
        issue["field"] = "Inputs"
    elif m := _OUTPUT_RE.match(message):
        t, ds = m.group(1), m.group(2) or m.group(3) or m.group(4)
        issue["edge"] = [t, dataset_node(ds)]
        issue["nodes"] = [t, dataset_node(ds)]
        issue["field"] = "Output"
    elif m := _CYCLE_RE.match(message):
        issue["nodes"] = [n.strip() for n in m.group(1).split(",")]
    elif m := _TRANSFORMER_RE.match(message):
        issue["node"] = m.group(1)
        issue["field"] = m.group(2)
    elif m := _DATASET_RE.match(message):
        issue["node"] = dataset_node(m.group(1))
        issue["field"] = m.group(2)
    elif message.startswith(("Name", "Catalog", "Clusters", "Schemas", "ConsumerGroup", "manifest", "Transformers")):
        issue["field"] = message.split(":", 1)[0]
    if issue["node"] and not issue["nodes"]:
        issue["nodes"] = [issue["node"]]
    return issue


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

    @property
    def example_catalog(self) -> Path:
        return self.root / "catalog.yaml"

    @property
    def example_manifest(self) -> Path:
        return self.root / "PipelineManifest.yaml"

    @cached_property
    def rust_schema_names(self) -> dict[str, str]:
        """Rust type -> Schema::NAME, for transformer crates built on the old Rust SDK (if foundry still has it)."""
        for p in (self.root / "sdk" / "rust" / "foundry-schemas" / "src" / "lib.rs",
                  self.root / "sdk" / "foundry-schemas" / "src" / "lib.rs"):
            if p.is_file():
                return {m.group(1): m.group(2) for m in _SCHEMA_IMPL_RE.finditer(p.read_text())}
        return {"XmlPacket": "XmlPackets", "EncodedPacket": "EncodedPackets", "Packet": "Packets"}

    def locate(self, message: str) -> dict:
        return locate(message)
