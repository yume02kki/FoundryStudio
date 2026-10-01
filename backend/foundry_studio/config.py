"""Settings, read from the environment only. The GitLab token never leaves this process
except as an auth header to GitLab (and to git/glab child processes through the environment)."""

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
    # Projects scanned for transformer crates.
    transformer_projects: list[str] = field(default_factory=lambda: ["yume02kki/skywalker"])
    # The GitOps repo deploy.py pushes to.
    deploys_project: str = "yume02kki/PipelineDeploys"
    deploys_base: str = "main"
    poll_interval: float = 10.0
    # Full rescan even without events, to catch anything the events API missed.
    full_rescan_interval: float = 300.0
    # Checkout of foundry at the pinned commit (git submodule).
    foundry_dir: Path = REPO_ROOT / "vendor" / "foundry"
    # Local drafts written by Save: <workspace>/<Name>/manifest.yaml + <Name>.layout.json
    workspace: Path = REPO_ROOT / "workspace"
    # "demo" or a directory: serve GitLab from local git repos instead of gitlab.com.
    fake_gitlab: str | None = None
    # Kafka credentials for the live feed, laid out like the transformer runtime's:
    # <secrets_dir>/<SecretRef>/username and /password.
    secrets_dir: Path = Path("/var/run/secrets/foundry")
    # Where the manifest's sink Brokers really are from this machine, in the watcher's
    # `clusters:` format: [{match: <manifest Brokers>, connection: {<ConnectionSettings>}}].
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
        if env.get("STUDIO_TRANSFORMER_PROJECTS"):
            s.transformer_projects = _list(env["STUDIO_TRANSFORMER_PROJECTS"])
        s.deploys_project = env.get("STUDIO_DEPLOYS_PROJECT", s.deploys_project)
        s.deploys_base = env.get("STUDIO_DEPLOYS_BASE", s.deploys_base)
        s.poll_interval = float(env.get("STUDIO_POLL_INTERVAL", s.poll_interval))
        s.full_rescan_interval = float(env.get("STUDIO_FULL_RESCAN_INTERVAL", s.full_rescan_interval))
        if env.get("FOUNDRY_DIR"):
            s.foundry_dir = Path(env["FOUNDRY_DIR"]).resolve()
        if env.get("STUDIO_WORKSPACE"):
            s.workspace = Path(env["STUDIO_WORKSPACE"]).resolve()
        s.fake_gitlab = env.get("STUDIO_FAKE_GITLAB") or None
        if env.get("FOUNDRY_SECRETS_DIR"):
            s.secrets_dir = Path(env["FOUNDRY_SECRETS_DIR"]).expanduser().resolve()
        if env.get("STUDIO_KAFKA_CLUSTERS"):
            s.kafka_clusters = load_clusters(Path(env["STUDIO_KAFKA_CLUSTERS"]).expanduser())
        return s


def load_clusters(path: Path) -> list[dict]:
    """A YAML file with a `clusters:` list (a foundry watcher.yaml works as is)."""
    import yaml

    data = yaml.safe_load(path.read_text()) or {}
    clusters = data.get("clusters") if isinstance(data, dict) else data
    if not isinstance(clusters, list) or not all(
        isinstance(c, dict) and c.get("match") and isinstance(c.get("connection"), dict) for c in clusters
    ):
        raise ValueError(f"{path}: expected clusters: [{{match: ..., connection: {{...}}}}]")
    return clusters
