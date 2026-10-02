"""Access to the pinned foundry-platform/common/scripts checkout: manifest.py as a library.

manifest.py is the single source of truth for what a valid PipelineManifest.yaml is; the
`manifest.py validate` CLI runs the same check(). Nothing here re-implements a rule; we
only import it and attach each error to the node or edge it talks about.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from functools import cached_property
from pathlib import Path
from types import ModuleType

DATASET = "dataset:"  # node id prefix of a dataset on the canvas


def dataset_node(name: str) -> str:
    return f"{DATASET}{name}"


# The "where" prefixes manifest.py puts on its messages.
_IN_RE = re.compile(r"^Transforms\.([^.:\s]+)\.In: (?:no dataset '([^']+)'|(\S+) carries)")
_OUT_RE = re.compile(r"^Transforms\.([^.:\s]+)\.Out: (?:no dataset '([^']+)'|\S+ writes \S+ but (\S+) carries)")
_CYCLE_RE = re.compile(r"^Transforms: cycle among (.+)$")
_TRANSFORM_RE = re.compile(r"^Transforms\.([^.:\s]+)(?:\.([A-Za-z]+))?:")
_DATASET_RE = re.compile(r"^DataSets\.(.+?)(?:\.(Type|Config|DataSchema|Topic|ConnectionSettings))?: ")


def locate(message: str) -> dict:
    """What a manifest.py error is about: {message, node, edge, nodes, field}."""
    issue: dict = {"message": message, "node": None, "edge": None, "nodes": [], "field": None}
    if m := _IN_RE.match(message):
        t, ds = m.group(1), m.group(2) or m.group(3)
        issue["edge"] = [dataset_node(ds), t]
        issue["nodes"] = [dataset_node(ds), t]
        issue["field"] = "In"
    elif m := _OUT_RE.match(message):
        t, ds = m.group(1), m.group(2) or m.group(3)
        issue["edge"] = [t, dataset_node(ds)]
        issue["nodes"] = [t, dataset_node(ds)]
        issue["field"] = "Out"
    elif m := _CYCLE_RE.match(message):
        issue["nodes"] = [n.strip() for n in m.group(1).split(",")]
    elif m := _TRANSFORM_RE.match(message):
        issue["node"] = m.group(1)
        issue["field"] = m.group(2)
    elif m := _DATASET_RE.match(message):
        issue["node"] = dataset_node(m.group(1))
        issue["field"] = m.group(2)
    elif message.startswith(("Name", "Configs", "manifest")):
        issue["field"] = message.split(":", 1)[0]
    if issue["node"] and not issue["nodes"]:
        issue["nodes"] = [issue["node"]]
    return issue


class Foundry:
    def __init__(self, root: Path):
        self.root = root
        if not (root / "manifest" / "manifest.py").is_file():
            raise RuntimeError(
                f"{root}/manifest/manifest.py not found; run `git submodule update --init` "
                "(foundry-platform/common/scripts is pinned in vendor/scripts)"
            )

    @cached_property
    def manifest(self) -> ModuleType:
        spec = importlib.util.spec_from_file_location("foundry_manifest", self.root / "manifest" / "manifest.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["foundry_manifest"] = module
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

    def locate(self, message: str) -> dict:
        return locate(message)
