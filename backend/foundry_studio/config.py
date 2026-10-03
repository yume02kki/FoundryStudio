"""Settings, read from the environment only. The GitLab token never leaves this process
except as an auth header to GitLab (and to git child processes through the environment)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass
class Settings:
    gitlab_url: str = "https://gitlab.com"
    # Projects scanned for processors (folders with an operator.yaml). None: every project
    # the token's user is a member of, re-listed so new projects show up on their own.
    processor_projects: list[str] | None = None
    poll_interval: float = 10.0
    # Full rescan even without events, to catch anything the events API missed.
    full_rescan_interval: float = 300.0
    # Checkout of foundry-platform/common/scripts at the pinned commit (git submodule): its validators.
    scripts_dir: Path = REPO_ROOT / "vendor" / "scripts"
    # The pipelines Studio edits: <workspace>/<folder>/PipelineManifest.yaml, one folder (a
    # pipeline repo checkout, ideally) per pipeline. None: <repo>/workspace (or the demo's).
    workspace: Path | None = None
    # The pipelines repo, one folder per pipeline; the workspace is kept a checkout of it. None: the
    # workspace is a plain folder (the default with a fake GitLab).
    pipelines_repo: str | None = "https://gitlab.com/foundry-platform/pipelines.git"
    # Connection profiles (kafka/<name>.json) for manifests without ConfigRegistry.Repo, and new ones.
    configs_repo: str = "https://gitlab.com/foundry-platform/common/configRegistry.git"
    # schemaRegistry: its types (folders with a metadata.yaml) are the names AllowedTypes and
    # operator.yaml in/out may use.
    schema_registry_repo: str = "https://gitlab.com/foundry-platform/common/schemaRegistry.git"
    # "demo" or a directory: serve GitLab from local git repos instead of gitlab.com.
    fake_gitlab: str | None = None
    # Kafka credentials for the live feed, laid out like the processor runtime's:
    # <secrets_dir>/<SecretRef>/username and /password.
    secrets_dir: Path = Path("/var/run/secrets/foundry")
    # Where the catalog's Brokers really are from this machine (for the live feed):
    # [{match: <catalog Brokers>, connection: {<connection settings>}}].
    kafka_clusters: list[dict] = field(default_factory=list)

    @property
    def token(self) -> str | None:
        # Read on demand so it is never stored on an object that might get logged.
        return os.environ.get("GITLAB_TOKEN") or None

    @property
    def webhook_secret(self) -> str | None:
        return os.environ.get("GITLAB_WEBHOOK_SECRET") or None

    @classmethod
    def from_env(cls) -> "Settings":
        s = cls()
        env = os.environ
        s.gitlab_url = env.get("GITLAB_URL", s.gitlab_url).rstrip("/")
        if env.get("STUDIO_PROCESSOR_PROJECTS", "*").strip() not in ("", "*"):
            s.processor_projects = _list(env["STUDIO_PROCESSOR_PROJECTS"])
        s.poll_interval = float(env.get("STUDIO_POLL_INTERVAL", s.poll_interval))
        s.full_rescan_interval = float(env.get("STUDIO_FULL_RESCAN_INTERVAL", s.full_rescan_interval))
        if env.get("FOUNDRY_SCRIPTS_DIR"):
            s.scripts_dir = Path(env["FOUNDRY_SCRIPTS_DIR"]).resolve()
        if env.get("STUDIO_WORKSPACE"):
            s.workspace = Path(env["STUDIO_WORKSPACE"]).expanduser().resolve()
        s.configs_repo = env.get("STUDIO_CONFIGS_REPO", s.configs_repo)
        s.schema_registry_repo = env.get("STUDIO_SCHEMA_REGISTRY_REPO", s.schema_registry_repo)
        s.fake_gitlab = env.get("STUDIO_FAKE_GITLAB") or None
        if "STUDIO_PIPELINES_REPO" in env or s.fake_gitlab:
            s.pipelines_repo = env.get("STUDIO_PIPELINES_REPO") or None
        if env.get("FOUNDRY_SECRETS_DIR"):
            s.secrets_dir = Path(env["FOUNDRY_SECRETS_DIR"]).expanduser().resolve()
        if env.get("STUDIO_KAFKA_CLUSTERS"):
            s.kafka_clusters = load_clusters(Path(env["STUDIO_KAFKA_CLUSTERS"]).expanduser())
        return s


def load_clusters(path: Path) -> list[dict]:
    """A YAML file with a `clusters:` list of {match, connection}."""
    import yaml

    data = yaml.safe_load(path.read_text()) or {}
    clusters = data.get("clusters") if isinstance(data, dict) else data
    if not isinstance(clusters, list) or not all(
        isinstance(c, dict) and c.get("match") and isinstance(c.get("connection"), dict) for c in clusters
    ):
        raise ValueError(f"{path}: expected clusters: [{{match: ..., connection: {{...}}}}]")
    return clusters
