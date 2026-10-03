"""Access to the pinned foundry-platform/common/scripts checkout: its validators as a library.

scripts decides what a valid PipelineManifest.yaml is: lib/pipeline.py (manifest format, profiles,
model types), validators/pipelines/typecheck.py and cycles.py, the same checks the pipelines CI
runs. Nothing here re-implements a rule; we only import them and attach each error to the node or
edge it talks about.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from functools import cached_property
from pathlib import Path
from types import ModuleType

DATASET = "dataset:"  # node id prefix of a Kafka on the canvas


def dataset_node(name: str) -> str:
    return f"{DATASET}{name}"


# The "where" prefixes the validators put on their messages.
_EDGE_RE = re.compile(r"^Flow: (\S+) -> (\S+):")
_CYCLE_RE = re.compile(r"^Flow has a cycle: (.+)$")
_KAFKA_RE = re.compile(r"^Kafkas\.([^.:\s]+)(?:\.(Config|AllowedTypes|Topic|ConnectionSettings))?: ")
_PROCESSOR_RE = re.compile(r"^Processors\.([^.:\s]+)(?:\.([A-Za-z]+))?:")
_NAME_RE = re.compile(r"^([^\s:.]+): ")


def locate(message: str, kafkas: set[str] = frozenset(), processors: set[str] = frozenset()) -> dict:
    """What a validator error is about: {message, node, edge, nodes, field}."""
    issue: dict = {"message": message, "node": None, "edge": None, "nodes": [], "field": None}

    def node(name: str) -> str:
        return dataset_node(name) if name in kafkas and name not in processors else name

    if m := _EDGE_RE.match(message):
        a, b = node(m.group(1)), node(m.group(2))
        issue["edge"] = [a, b]
        issue["nodes"] = [a, b]
        issue["field"] = "Flow"
    elif m := _CYCLE_RE.match(message):
        issue["nodes"] = list(dict.fromkeys(node(n.strip()) for n in m.group(1).split("->")))
    elif m := _KAFKA_RE.match(message):
        issue["node"] = dataset_node(m.group(1))
        issue["field"] = m.group(2)
    elif m := _PROCESSOR_RE.match(message):
        issue["node"] = m.group(1)
        issue["field"] = m.group(2)
    elif message.startswith(("Name", "ConfigRegistry", "Flow")):
        issue["field"] = message.split(":", 1)[0].split(".")[0].split("[")[0]
    elif (m := _NAME_RE.match(message)) and (m.group(1) in kafkas or m.group(1) in processors):
        issue["node"] = node(m.group(1))
    if issue["node"] and not issue["nodes"]:
        issue["nodes"] = [issue["node"]]
    return issue


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Foundry:
    def __init__(self, root: Path):
        self.root = root
        if not (root / "lib" / "pipeline.py").is_file():
            raise RuntimeError(
                f"{root}/lib/pipeline.py not found; run `git submodule update --init` "
                "(foundry-platform/common/scripts is pinned in vendor/scripts)"
            )

    @cached_property
    def pipeline(self) -> ModuleType:
        """lib/pipeline.py: the manifest format, profiles, model types. Loaded as `pipeline`, the name
        the validators import it by."""
        return _load("pipeline", self.root / "lib" / "pipeline.py")

    @cached_property
    def typecheck(self) -> ModuleType:
        self.pipeline  # noqa: B018 (typecheck imports it)
        return _load("foundry_typecheck", self.root / "validators" / "pipelines" / "typecheck.py")

    @cached_property
    def cycles(self) -> ModuleType:
        self.pipeline  # noqa: B018
        return _load("foundry_cycles", self.root / "validators" / "pipelines" / "cycles.py")

    @cached_property
    def commit(self) -> str | None:
        try:
            return subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True, check=True
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None
