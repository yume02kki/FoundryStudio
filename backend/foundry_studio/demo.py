"""Offline demo: a local stand-in for skywalker, a workspace, and a deploy target.

    python -m foundry_studio.demo init                     # (re)create the demo
    python -m foundry_studio.demo tag Base64Decoder v0.4.3 # commit + tag, like a release push
    python -m foundry_studio.demo add Deduplicate Packets Packets "Drops repeated guids"
    python -m foundry_studio.demo remove Deduplicate

The transformers are stand-ins with the shape of skywalker's C# ones (the real repo is
private). The workspace starts with foundry's example catalog and SWpipeline. The deploy
target uses `Runner: none`: deploys are recorded (history, rollback) and the docker
commands they would run are printed, so the demo needs neither Docker nor Kafka.
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
SKYWALKER = "yume02kki/skywalker"
SDK_VERSION = "0.3.0"
CS_TYPES = {"XmlPackets": "XmlPacket", "EncodedPackets": "EncodedPacket", "Packets": "Packet"}

# Fixed dates keep commit SHAs identical across `init` runs.
FIXED_DATE = "2026-09-01T12:00:00+00:00"


def workspace(root: Path) -> Path:
    return root / "workspace"


def target_file(root: Path) -> Path:
    return root / "target.yaml"


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


def transformer_files(name: str, input: str, output: str, version: str = "0.4.2",
                      description: str | None = None) -> dict[str, str]:
    """A C# transformer folder as TRANSFORMERS.md describes it."""
    cin, cout = CS_TYPES.get(input, input), CS_TYPES.get(output, output)
    body = ("            yield return p;" if cin == cout else
            f"            yield return new {cout} {{ Guid = p.Guid, Data = p.Data, TimeSent = p.TimeSent,\n"
            "                HostIp = p.HostIp, TargetIp = p.TargetIp };")
    return {
        "transformer.yaml": f"name: {name}\nin: {input}\nout: {output}\ndescription: {description or name}\n",
        f"{name}.csproj": (
            '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n'
            "    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n"
            "    <ImplicitUsings>enable</ImplicitUsings>\n"
            "    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>\n"
            f"    <Version>{version}</Version>\n  </PropertyGroup>\n  <ItemGroup>\n"
            f'    <PackageReference Include="Foundry.Transformer" Version="{SDK_VERSION}" />\n'
            "  </ItemGroup>\n</Project>\n"),
        "packages.lock.json": f'{{\n  "version": 1,\n  "dependencies": {{}},\n  "_demo": "placeholder lock file for {name}"\n}}\n',
        "Program.cs": (
            "using Foundry.Schemas;\nusing Foundry.Transformer;\n\n"
            f"return Runtime.Run(new {name}());\n\n"
            f"sealed class {name} : ITransformer<{cin}, {cout}>\n{{\n"
            f"    public async IAsyncEnumerable<{cout}> Transform(Records<{cin}> input)\n    {{\n"
            f"        await foreach (var p in input)\n{body}\n    }}\n}}\n"),
        "Dockerfile": (
            "FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build\nWORKDIR /src\nCOPY . .\n"
            "RUN dotnet publish -c Release --locked-mode -o /app\n\n"
            "FROM mcr.microsoft.com/dotnet/runtime:8.0\nCOPY --from=build /app /app\n"
            f'ENTRYPOINT ["dotnet", "/app/{name}.dll"]\n'),
    }


def _write(repo: Path, folder: str, files: dict[str, str]) -> None:
    for rel, text in files.items():
        p = repo / folder / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


def init(root: Path = DEFAULT_ROOT, foundry_dir: Path = REPO_ROOT / "vendor" / "foundry") -> Path:
    from .foundry import Foundry
    from .pipelines import seed

    if root.exists():
        shutil.rmtree(root)
    sky = root / SKYWALKER
    sky.mkdir(parents=True)
    _git(sky, "init", "-q", "-b", "main")
    (sky / "README.md").write_text("# skywalker (demo)\n\nOne folder per transformer.\n")
    _write(sky, "XmlToJson", transformer_files("XmlToJson", "XmlPackets", "EncodedPackets",
                                               description="Converts XML packets to JSON, data still base64"))
    _write(sky, "Base64Decoder", transformer_files("Base64Decoder", "EncodedPackets", "Packets",
                                                   description="Decodes each packet's base64 data"))
    _git(sky, "add", "-A")
    _git(sky, "commit", "-q", "-m", "XmlToJson and Base64Decoder 0.4.2", date=FIXED_DATE)
    for name in ("XmlToJson", "Base64Decoder"):
        _git(sky, "tag", f"{name}/v0.4.2", date=FIXED_DATE)

    seed(workspace(root), Foundry(foundry_dir))
    target_file(root).write_text(
        "# Demo deploy target: deploys are recorded, nothing runs (no Docker, no Kafka needed).\n"
        "Runner: none\nCheckTopics: false\nStateDir: state\n")
    return root


def tag(root: Path, name: str, version: str) -> str:
    sky = root / SKYWALKER
    csproj = sky / name / f"{name}.csproj"
    csproj.write_text(re.sub(r"<Version>[^<]*</Version>", f"<Version>{version.lstrip('v')}</Version>",
                             csproj.read_text()))
    _git(sky, "add", "-A")
    _git(sky, "commit", "-q", "-m", f"{name} {version}")
    _git(sky, "tag", f"{name}/{version}")
    return f"{name}/{version}"


def add(root: Path, name: str, input: str, output: str, description: str | None = None) -> None:
    sky = root / SKYWALKER
    _write(sky, name, transformer_files(name, input, output, "0.1.0", description))
    _git(sky, "add", "-A")
    _git(sky, "commit", "-q", "-m", f"Add {name}")


def remove(root: Path, name: str) -> None:
    sky = root / SKYWALKER
    _git(sky, "rm", "-rq", name)
    _git(sky, "commit", "-q", "-m", f"Remove {name}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m foundry_studio.demo", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path(os.environ.get("STUDIO_DEMO_ROOT", DEFAULT_ROOT)))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    s = sub.add_parser("tag"); s.add_argument("name"); s.add_argument("version")
    s = sub.add_parser("add"); s.add_argument("name"); s.add_argument("input"); s.add_argument("output")
    s.add_argument("description", nargs="?")
    s = sub.add_parser("remove"); s.add_argument("name")
    a = ap.parse_args(argv)
    if a.cmd == "init":
        print(f"demo in {init(a.root)}")
    elif a.cmd == "tag":
        print(f"tagged {tag(a.root, a.name, a.version)}")
    elif a.cmd == "add":
        add(a.root, a.name, a.input, a.output, a.description)
        print(f"added {a.name}")
    elif a.cmd == "remove":
        remove(a.root, a.name)
        print(f"removed {a.name}")


if __name__ == "__main__":
    main()
