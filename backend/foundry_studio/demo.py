"""Offline demo: local stand-ins for the foundry repos on GitLab, and a workspace.

    python -m foundry_studio.demo init                          # (re)create the demo
    python -m foundry_studio.demo tag decodingtransformer v1.1.0 # commit + tag, like a release push
    python -m foundry_studio.demo add Deduplicate Packets Packets "Drops repeated guids"
    python -m foundry_studio.demo remove Deduplicate

The repos mirror the real ones: foundry-platform/common/configs (connection profiles and schemas)
and one foundry-platform/enrichers project per transformer,
each with a transformer.yaml at its root. The workspace holds PacketPipeline. Nothing here
needs a token, Docker or Kafka; Live data shows generated records.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
from pathlib import Path

from .config import REPO_ROOT

DEFAULT_ROOT = REPO_ROOT / ".demo-gitlab"
CONFIGS = "foundry-platform/common/configs"
ENRICHERS = "foundry-platform/enrichers"

# Fixed dates keep commit SHAs identical across `init` runs.
FIXED_DATE = "2026-09-01T12:00:00+00:00"

PROFILES = {
    "kafka/prod.yaml": ("# Production cluster.\nConnectionSettings:\n  Brokers: kafka-internal:9092\n"
                        "  SecurityProtocol: SASL_SSL\n  SaslMechanism: SCRAM-SHA-512\n  SecretRef: kafka-internal-creds\n"),
    "kafka/load.yaml": ("# Load-testing cluster.\nConnectionSettings:\n  Brokers: kafka-load:9092\n"
                        "  SecurityProtocol: SASL_SSL\n  SaslMechanism: SCRAM-SHA-512\n  SecretRef: kafka-load-creds\n"),
}
_PACKET = "  guid: uuid\n  data: {data}\n{extra}  time_sent: datetime\n  host_ip: ip\n  target_ip: ip\n"
SCHEMAS = {
    "schemas/xml_packets.yaml": "format: xml\nfields:\n" + _PACKET.format(data="base64", extra=""),
    "schemas/packets.yaml": "format: json\nfields:\n" + _PACKET.format(data="string", extra=""),
    "schemas/enriched_packets.yaml": "format: json\nfields:\n" + _PACKET.format(data="string", extra="  ISP: string\n"),
}
TRANSFORMERS = {  # project -> (name, in, out, description)
    "xmltojsontransformer": ("XmlToJson", "XmlPackets", "Packets", "Converts XML packets to JSON; data stays base64."),
    "decodingtransformer": ("Decode", "Packets", "EnrichedPackets", "Decodes the base64 payload to text."),
    "IspEnricher": ("Isp", "Packets", "EnrichedPackets", "Adds the ISP of host_ip, from CIDR ranges in appsettings."),
}
MANIFEST = f"""\
# yaml-language-server: $schema=https://gitlab.com/foundry-platform/common/scripts/-/jobs/artifacts/main/raw/manifest.schema.json?job=schema
Name: EnrichmentPipeline

Configs:
  Repo: https://gitlab.com/{CONFIGS}.git
  # Ref: v1   # optional, defaults to main

# DataSchema names a schema in the Configs repo's schemas/ (types in the Foundry.Common.Models package).
DataSets:
  Input:
    Type: Kafka
    Config: kafka/prod
    DataSchema: XmlPackets
    Topic: raw.xml

  ConvertedPackets:
    Type: Kafka
    Config: kafka/prod
    DataSchema: Packets
    Topic: enrichment.packets

  Output:
    Type: Kafka
    Config: kafka/prod
    DataSchema: EnrichedPackets
    Topic: packets.enriched

Transforms:
  XmlToJson:
    Repo: https://gitlab.com/{ENRICHERS}/xmltojsontransformer.git
    In: Input
    Out: ConvertedPackets

  Decode:
    Repo: https://gitlab.com/{ENRICHERS}/decodingtransformer.git
    In: ConvertedPackets
    Out: Output

  Isp:
    Repo: https://gitlab.com/{ENRICHERS}/IspEnricher.git
    In: ConvertedPackets
    Out: Output
"""


def workspace(root: Path) -> Path:
    return root / "workspace"


def _git(repo: Path, *args: str, date: str | None = None) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "Foundry Demo", "GIT_AUTHOR_EMAIL": "demo@example.invalid",
           "GIT_COMMITTER_NAME": "Foundry Demo", "GIT_COMMITTER_EMAIL": "demo@example.invalid"}
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
    res = subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *args],
                         cwd=repo, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {res.stderr.strip()}")
    return res.stdout.strip()


def transformer_files(name: str, input: str, output: str, version: str = "1.0.0",
                      description: str | None = None) -> dict[str, str]:
    """A transformer repo in the shape of the real ones (minimal: no Kafka loop)."""
    return {
        "transformer.yaml": f"name: {name}\nin: {input}\nout: {output}\ndescription: {description or name}\n",
        f"{name}.csproj": (
            '<Project Sdk="Microsoft.NET.Sdk.Worker">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n'
            f"    <Version>{version}</Version>\n  </PropertyGroup>\n  <ItemGroup>\n"
            '    <PackageReference Include="Foundry.Common.Transformers" Version="1.*" />\n  </ItemGroup>\n</Project>\n'),
        "Program.cs": (f"using Foundry.Common.Models;\n\n// Demo stand-in: {input} -> {output}.\n"
                       f"static {output} Transform({input} p) => new() {{ Guid = p.Guid }};\n"),
    }


def _repo(root: Path, project: str, files: dict[str, str], message: str, tag: str | None = None) -> Path:
    repo = root / project
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message, date=FIXED_DATE)
    if tag:
        _git(repo, "tag", tag, date=FIXED_DATE)
    return repo


def init(root: Path = DEFAULT_ROOT) -> Path:
    if root.exists():
        shutil.rmtree(root)
    _repo(root, CONFIGS, {**PROFILES, **SCHEMAS}, "Kafka connection profiles and packet schemas")
    for project, (name, i, o, desc) in TRANSFORMERS.items():
        _repo(root, f"{ENRICHERS}/{project}", transformer_files(name, i, o, description=desc), f"{name} 1.0.0", "v1.0.0")
    # A plain folder (not a git repo), so the fake GitLab doesn't list it as a project.
    (workspace(root) / "PacketPipeline").mkdir(parents=True)
    (workspace(root) / "PacketPipeline" / "PipelineManifest.yaml").write_text(MANIFEST)
    return root


def tag(root: Path, project: str, version: str) -> str:
    repo = root / ENRICHERS / project
    csproj = next(repo.glob("*.csproj"))
    csproj.write_text(re.sub(r"<Version>[^<]*</Version>", f"<Version>{version.lstrip('v')}</Version>",
                             csproj.read_text()))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", f"{project} {version}")
    _git(repo, "tag", version)
    return f"{project} {version}"


def add(root: Path, name: str, input: str, output: str, description: str | None = None) -> None:
    _repo(root, f"{ENRICHERS}/{name}", transformer_files(name, input, output, "0.1.0", description), f"Add {name}")


def remove(root: Path, name: str) -> None:
    repo = root / ENRICHERS / name
    _git(repo, "rm", "-q", "transformer.yaml")
    _git(repo, "commit", "-q", "-m", f"{name} is no longer a transformer")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m foundry_studio.demo", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path(os.environ.get("STUDIO_DEMO_ROOT", DEFAULT_ROOT)))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    s = sub.add_parser("tag"); s.add_argument("project"); s.add_argument("version")
    s = sub.add_parser("add"); s.add_argument("name"); s.add_argument("input"); s.add_argument("output")
    s.add_argument("description", nargs="?")
    s = sub.add_parser("remove"); s.add_argument("name")
    a = ap.parse_args(argv)
    if a.cmd == "init":
        print(f"demo in {init(a.root)}")
    elif a.cmd == "tag":
        print(f"tagged {tag(a.root, a.project, a.version)}")
    elif a.cmd == "add":
        add(a.root, a.name, a.input, a.output, a.description)
        print(f"added {a.name}")
    elif a.cmd == "remove":
        remove(a.root, a.name)
        print(f"removed {a.name}")


if __name__ == "__main__":
    main()
