"""Offline demo: a local stand-in for skywalker and PipelineDeploys.

    python -m foundry_studio.demo init                     # (re)create the demo repos
    python -m foundry_studio.demo tag Base64Decoder v0.4.3 # commit + tag, like a release push
    python -m foundry_studio.demo add Deduplicate Packets Packets "Drops repeated guids"
    python -m foundry_studio.demo remove Deduplicate
    python -m foundry_studio.demo ci 1 failed             # set a merge request's CI status

The crates are stand-ins with the shape of skywalker's (the real repo is private);
PipelineDeploys/SWpipeline is rendered by deploy.py from foundry's PipelineManifest.yaml,
so deploying an unchanged SWpipeline reports "already up to date".
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .config import REPO_ROOT

DEFAULT_ROOT = REPO_ROOT / ".demo-gitlab"
SKYWALKER = "yume02kki/skywalker"
DEPLOYS = "yume02kki/PipelineDeploys"
SDK = '{ git = "https://gitlab.com/yume02kki/foundry.git", tag = "sdk-v0.1.1" }'
RUST_TYPES = {"XmlPackets": "XmlPacket", "EncodedPackets": "EncodedPacket", "Packets": "Packet"}

# Fixed dates keep commit SHAs, and therefore renders, identical across `init` runs.
FIXED_DATE = "2026-09-01T12:00:00+00:00"


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


def crate_files(name: str, input: str, output: str, version: str = "0.4.2",
                description: str | None = None, declare: bool = False) -> dict[str, str]:
    rin, rout = RUST_TYPES.get(input, input), RUST_TYPES.get(output, output)
    package = "".join("-" + c.lower() if c.isupper() and i else c.lower() for i, c in enumerate(name))
    files = {
        "Cargo.toml": f'[package]\nname = "{package}"\nversion = "{version}"\nedition = "2021"\n\n'
                      f"[dependencies]\nfoundry-transformer = {SDK}\nfoundry-schemas = {SDK}\n",
        "Cargo.lock": f"# placeholder lock file for the demo crate {package}\nversion = 4\n",
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.89"\n',
        "Dockerfile": "FROM rust:1.89 AS build\nWORKDIR /src\nCOPY . .\nRUN cargo build --release --locked\n\n"
                      f"FROM debian:bookworm-slim\nCOPY --from=build /src/target/release/{package} /usr/local/bin/transformer\n"
                      'ENTRYPOINT ["/usr/local/bin/transformer"]\n',
        "src/main.rs": f"use foundry_schemas::{{{', '.join(sorted({rin, rout}))}}};\n"
                       "use foundry_transformer::{Dataset, Error, Transformer};\n\n"
                       f"struct {name};\n\nimpl Transformer for {name} {{\n"
                       f"    type In = {rin};\n    type Out = {rout};\n\n"
                       f"    fn transform(&mut self, input: Dataset<{rin}>) -> Result<Dataset<{rout}>, Error> {{\n"
                       "        input.into_iter().map(|p| Ok(p.into())).collect()\n    }\n}\n\n"
                       f"fn main() -> std::process::ExitCode {{\n    foundry_transformer::run({name})\n}}\n",
    }
    if declare:
        files["transformer.yaml"] = (
            f"name: {name}\nin: {input}\nout: {output}\ndescription: {description or name}\n"
        )
    return files


def _write(repo: Path, folder: str, files: dict[str, str]) -> None:
    for rel, text in files.items():
        p = repo / folder / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


def init(root: Path = DEFAULT_ROOT, foundry_dir: Path = REPO_ROOT / "vendor" / "foundry") -> Path:
    from .foundry import Foundry
    from .gitenv import add_git_config

    if root.exists():
        shutil.rmtree(root)
    sky = root / SKYWALKER
    sky.mkdir(parents=True)
    _git(sky, "init", "-q", "-b", "main")
    (sky / "README.md").write_text("# skywalker (demo)\n\nOne folder per transformer crate.\n")
    _write(sky, "XmlToJson", crate_files("XmlToJson", "XmlPackets", "EncodedPackets"))
    _write(sky, "Base64Decoder", crate_files("Base64Decoder", "EncodedPackets", "Packets"))
    _git(sky, "add", "-A")
    _git(sky, "commit", "-q", "-m", "XmlToJson and Base64Decoder 0.4.2", date=FIXED_DATE)
    for crate in ("XmlToJson", "Base64Decoder"):
        _git(sky, "tag", f"{crate}/v0.4.2", date=FIXED_DATE)

    deploys = root / DEPLOYS
    deploys.mkdir(parents=True)
    _git(deploys, "init", "-q", "-b", "main")
    (deploys / "README.md").write_text("# PipelineDeploys (demo)\n\nRendered by deploy.py. One folder per pipeline.\n")

    foundry = Foundry(foundry_dir)
    env_backup = dict(os.environ)
    try:
        add_git_config(os.environ, [(f"url.{sky.resolve()}.insteadOf", f"https://gitlab.com/{SKYWALKER}.git")])
        with tempfile.TemporaryDirectory() as tmp:
            foundry.deploy.render(foundry_dir / "PipelineManifest.yaml", Path(tmp) / "SWpipeline")
            shutil.copytree(Path(tmp) / "SWpipeline", deploys / "SWpipeline")
    finally:
        os.environ.clear()
        os.environ.update(env_backup)
    _git(deploys, "add", "-A")
    _git(deploys, "commit", "-q", "-m", "deploy(SWpipeline)", date=FIXED_DATE)
    return root


def tag(root: Path, crate: str, version: str) -> str:
    sky = root / SKYWALKER
    cargo = sky / crate / "Cargo.toml"
    text = cargo.read_text()
    lines = [f'version = "{version.lstrip("v")}"' if line.startswith("version = ") else line for line in text.splitlines()]
    cargo.write_text("\n".join(lines) + "\n")
    _git(sky, "add", "-A")
    _git(sky, "commit", "-q", "-m", f"{crate} {version}")
    _git(sky, "tag", f"{crate}/{version}")
    return f"{crate}/{version}"


def add(root: Path, name: str, input: str, output: str, description: str | None = None) -> None:
    sky = root / SKYWALKER
    _write(sky, name, crate_files(name, input, output, "0.1.0", description, declare=True))
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
    s = sub.add_parser("tag"); s.add_argument("crate"); s.add_argument("version")
    s = sub.add_parser("add"); s.add_argument("name"); s.add_argument("input"); s.add_argument("output")
    s.add_argument("description", nargs="?")
    s = sub.add_parser("remove"); s.add_argument("name")
    s = sub.add_parser("ci"); s.add_argument("iid", type=int); s.add_argument("status")
    a = ap.parse_args(argv)
    if a.cmd == "init":
        print(f"demo repos in {init(a.root)}")
    elif a.cmd == "tag":
        print(f"tagged {tag(a.root, a.crate, a.version)}")
    elif a.cmd == "add":
        add(a.root, a.name, a.input, a.output, a.description)
        print(f"added {a.name}")
    elif a.cmd == "remove":
        remove(a.root, a.name)
        print(f"removed {a.name}")
    elif a.cmd == "ci":
        from .fake_gitlab import FakeGitLab

        FakeGitLab(a.root).set_pipeline_status(DEPLOYS, a.iid, a.status)
        print(f"!{a.iid}: CI {a.status}")


if __name__ == "__main__":
    main()
