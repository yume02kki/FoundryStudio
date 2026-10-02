# Foundry Studio

A visual editor for Foundry pipelines' `PipelineManifest.yaml`, in the spirit of Palantir Foundry's Pipeline Builder. Studio only edits and displays manifests; whether one is valid is decided by `manifest.py` from [foundry-common/scripts](https://gitlab.com/foundry-common/scripts), the same check its `validate` CLI runs.

On the canvas, **datasets** (the manifest's `DataSets`: Kafka topics) and **transforms** are both nodes: `dataset → transform → dataset`. A transform reads one dataset (`In`) and writes one (`Out`); a dataset can feed several transforms, and several transforms can write one dataset. GitLab is watched live: any project with a `transformer.yaml` shows up as a building block, without a reload.

- **Backend:** Python + FastAPI (`backend/`). It imports `manifest.py` as a library, so the UI and the CLI can't disagree about what a valid pipeline is.
- **Frontend:** React + TypeScript + Vite, with React Flow (`@xyflow/react`) for the canvas (`frontend/`).
- **foundry-common/scripts** is pinned as a git submodule at `vendor/scripts`.

## The model

```yaml
# <workspace>/PacketPipeline/PipelineManifest.yaml
Name: EnrichmentPipeline
Configs:
  Repo: https://gitlab.com/foundry-common/configs.git   # connection profiles (kafka/prod, ...)
DataSets:
  Input:
    Type: Kafka
    Config: kafka/prod          # a profile from the configs repo
    DataSchema: XmlPackets      # a schema in the configs repo's schemas/
    Topic: raw.xml
Transforms:
  XmlToJson:
    Repo: https://gitlab.com/foundry-enrichers/xmltojsontransformer.git
    In: Input
    Out: ConvertedPackets
```

What a manifest refers to is read through the GitLab API, read-only:

| | From | Used for |
|---|---|---|
| Connection profiles | the manifest's `Configs.Repo` at `Configs.Ref` | the Profile picker, validation, Live data |
| Schemas | the default configs repo's (`STUDIO_CONFIGS_REPO`) `schemas/*.yaml` | the Schema picker and field list, validation, Live data's checks |
| Transform schemas | each transformer's `transformer.yaml` at the transform's `Ref` | port colours, wiring rules, validation |

Nothing here creates topics or edits profiles or schemas.

## Quick start

Requirements: Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), Node ≥ 20, and git.

```sh
make setup                              # submodule + Python and Node dependencies

export GITLAB_TOKEN=glpat-…             # read_api (optional for public projects)
export STUDIO_WORKSPACE=~/Desktop/FoundryStuff   # a folder of pipeline repo checkouts
make dev                                # backend :8000 + frontend :5173, both auto-reloading
```

Open <http://127.0.0.1:5173>. Without a token, set `STUDIO_TRANSFORMER_PROJECTS` to the transformer projects to watch (listing "every project I'm a member of" needs one).

### Offline demo (no token, no Kafka)

```sh
make demo
```

The demo serves local git repos standing in for `foundry-common/configs` and the three `foundry-enrichers` transformers, and a workspace with PacketPipeline. Live data shows generated records, labelled **demo data**. To see live updates, "push" from another terminal:

```sh
cd backend
uv run python -m foundry_studio.demo tag decodingtransformer v1.1.0    # update badge appears
uv run python -m foundry_studio.demo add Deduplicate Packets Packets   # a new card appears
make demo-reset                                                       # start over
```

## The workspace

`STUDIO_WORKSPACE` holds one folder per pipeline. Studio keeps it a checkout of the pipelines repo, [foundry-common/foundry-pipelines](https://gitlab.com/foundry-common/foundry-pipelines) (`STUDIO_PIPELINES_REPO`): it clones it into an empty workspace and fast-forwards it on every push, unless the workspace has changes not committed yet.

```
<workspace>/<folder>/PipelineManifest.yaml          the pipeline
<workspace>/<folder>/PipelineManifest.layout.json   node positions
```

A pipeline is known by its folder; its `Name` is a field. A new pipeline gets a folder named after it. **Save** writes these two files and nothing else; commit and push them with git.

## Building pipelines

- **Transformers** tab: drag a card onto the canvas. It's added without a `Ref` (its default branch). Pin a tag in the Inspector; a pinned node shows an update badge when a newer tag exists.
- **Datasets** tab: this pipeline's datasets, the datasets other pipelines in the workspace define (drag one in to reuse its topic), and the profiles (read-only). **+ Dataset** defines a new one.
- **Wiring:** drag from a port to a port. Compatible ports light up while dragging; a refused wire says why in manifest.py's words, e.g. `XmlToJson writes Packets but Output carries EnrichedPackets`, or that a transform already has its `In`.
- **Inspector:** a transform's version, schemas (from `transformer.yaml`) and consumer group (`<Name>.<transform>`); a dataset's topic, profile, schema (with its fields) and optional inline `ConnectionSettings` overrides, with the profile's settings shown read-only; with nothing selected, the pipeline's `Configs` repo and ref.
- **Validation** runs `manifest.py`'s `check()` on every change; the top bar shows its errors verbatim, and clicking one zooms to the node or connection it's about.

The manifest is written in one **canonical form** (the pipelines' own layout and comments, transforms in topological order, datasets in data-flow order), so the same pipeline always produces the same bytes however it was dragged and wired.

## Live data

Press **Live data** in the top bar. Studio follows every dataset on the canvas: connections animate while data flows, transforms show `N in → M out/min` and how many records they dropped, and the **Overview** lists every stage. Click to drill in: a transform shows its input records next to its output records (matched by Kafka key or `guid`, with a field-by-field diff), a dataset or connection shows its messages. Every message is checked against its dataset's schema.

It's **read-only**: Studio assigns partitions under a throwaway group id, never joins a transform's consumer group, and never commits offsets. Credentials come from `$FOUNDRY_SECRETS_DIR/<SecretRef>/username` and `/password`.

## Transformer discovery and real-time updates

Studio scans projects for a **`transformer.yaml`**, at the repo root or in any folder:

```yaml
name: Isp
in: Packets
out: EnrichedPackets
description: Adds the ISP of host_ip.
```

A transformer's versions are its `v*` tags (`<Path>/v*` in a folder), newest semver first, plus the last default-branch commit that touched it. Projects are polled every `STUDIO_POLL_INTERVAL` seconds; changes reach the browser over Server-Sent Events. **Webhooks** (optional, faster): add a project or group webhook to `https://<host>/api/webhooks/gitlab` with a secret token, start the backend with `GITLAB_WEBHOOK_SECRET=<secret>`, and enable **Push** and **Tag push** events.

## Configuration

| Variable | Default | |
|---|---|---|
| `GITLAB_TOKEN` | – | `read_api`; never written to disk, logged, or put in a URL |
| `GITLAB_URL` | `https://gitlab.com` | Self-hosted GitLab works too |
| `STUDIO_TRANSFORMER_PROJECTS` | every project you're a member of | Or a comma-separated list of projects |
| `STUDIO_WORKSPACE` | `./workspace` | The pipeline folders Studio edits |
| `STUDIO_PIPELINES_REPO` | `https://gitlab.com/foundry-common/foundry-pipelines.git` | The workspace is a checkout of it; empty: a plain folder (the default with `STUDIO_FAKE_GITLAB`) |
| `STUDIO_CONFIGS_REPO` | `https://gitlab.com/foundry-common/configs.git` | Profiles for manifests without `Configs.Repo`, and new pipelines; schemas |
| `STUDIO_POLL_INTERVAL` | `10` | Seconds between polls |
| `STUDIO_FULL_RESCAN_INTERVAL` | `300` | Full rescan of every project even without events |
| `GITLAB_WEBHOOK_SECRET` | – | Enables `/api/webhooks/gitlab` |
| `STUDIO_FAKE_GITLAB` | – | `demo`, or a directory of local repos (tests, e2e) |
| `STUDIO_KAFKA_CLUSTERS` | – | YAML `clusters: [{match: <Brokers>, connection: {…}}]`, for when brokers are reached differently from this machine (Live data only) |
| `FOUNDRY_SECRETS_DIR` | `/var/run/secrets/foundry` | Kafka credentials for Live data |
| `FOUNDRY_SCRIPTS_DIR` | `./vendor/scripts` | Use another foundry-common/scripts checkout |

## Running Studio on a server

```sh
scripts/deploy_server.sh ubuntu@<host>          # from your machine, in this checkout
ssh -N -L 8000:127.0.0.1:8000 ubuntu@<host>      # then open http://localhost:8000
```

Studio has no login, so it listens on **127.0.0.1 only**. Settings go in `/etc/foundry-studio.env` (mode 600).

## Tests

```sh
make test     # backend pytest + frontend typecheck and vitest
make e2e      # Playwright, against a fresh offline demo
```

## Layout

```
backend/foundry_studio/
  app.py           FastAPI routes, SSE (events, live data), webhook
  foundry.py       manifest.py loader, error locator
  manifest.py      graph <-> PipelineManifest.yaml (canonical writer)
  validation.py    manifest.py's check() + transformer.yaml schemas, edge checks, dataset endpoints
  sources.py       connection profiles and schemas through the GitLab API
  pipelines.py     the workspace: pipeline folders
  discovery.py     transformer.yaml folders and their versions
  watcher.py       every member project: polling + webhooks -> event bus
  peek.py          Live data: read-only topic feeds, schema checks
  gitlab.py        GitLab REST client
  fake_gitlab.py   GitLab look-alike on local git repos (tests, demo)
  demo.py          offline demo + CLI
frontend/src/
  components/      Canvas, PipelineNode, TopicEdge, AssetBrowser, Datasets, Inspector, TopBar, LiveData, Dialogs
  lib/             rules (wiring), stages/pairing/diff, versions, layout, feed health, schema colours
  store.ts         zustand store
vendor/scripts     foundry-common/scripts (submodule)
```
