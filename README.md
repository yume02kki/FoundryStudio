# Foundry Studio

A visual pipeline builder for foundry pipelines, in the spirit of Palantir Foundry's Pipeline
Builder. Pipelines are defined by manifest YAML; Studio only edits and displays it, and Deploy
hands the saved manifest to foundry's `deploy.py`.

On the canvas, **datasets** (registered Kafka topics from the shared catalog) and
**transformers** are both nodes: `dataset → transformer → dataset`. A dataset can feed several
transformers, a transformer can read and write several datasets, and several transformers can
write one dataset. GitLab is watched live: any project with a `transformer.yaml` in a folder
shows up as a transformer, without a reload.

![Foundry Studio](docs/screenshot.png)

- **Backend:** Python + FastAPI (`backend/`). It imports foundry's `deploy.py` as a library, so the
  UI and the CLI can't disagree about what a valid pipeline is.
- **Frontend:** React + TypeScript + Vite, with React Flow (`@xyflow/react`) for the canvas (`frontend/`).
- **foundry** is pinned as a git submodule at `vendor/foundry`.

## The model

Topics live on shared clusters and are registered by hand; many services read the same topic,
each in its own consumer group. So nothing here creates a topic. Two kinds of file describe
everything:

```yaml
# workspace/catalog.yaml: shared by every pipeline
Clusters:
  upstream: {Brokers: upstream-kafka:9092, SecurityProtocol: SASL_SSL, SaslMechanism: SCRAM-SHA-512, SecretRef: upstream-kafka-creds}
Schemas:
  XmlPackets: schemas/xml_packets.yaml
Datasets:                      # registered topics, by their real name
  raw.xml: {Cluster: upstream, Schema: XmlPackets}
```

```yaml
# workspace/SWpipeline/manifest.yaml
Name: SWpipeline
Catalog: ../catalog.yaml
Transformers:
  XmlToJson:
    Repo: https://gitlab.com/yume02kki/skywalker.git
    Path: XmlToJson
    IN: XmlPackets             # transformer.yaml's in/out; must match the datasets' schemas
    OUT: EncodedPackets
    Inputs: [raw.xml]
    Output: SWpipeline.XmlToJson.out      # or a list: every output record goes to each
```

The consumer group of a transformer is `<ConsumerGroup or Name>.<transformer>`. `ConsumerGroup`
can be set per pipeline or per transformer. See foundry's `catalog.yaml`, `PipelineManifest.yaml`
and `deploy.py` for the full format.

## Quick start

Requirements: Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), Node ≥ 20, and git.

```sh
make setup                          # submodule + Python and Node dependencies

export GITLAB_TOKEN=glpat-…         # read_api + read_repository
export STUDIO_WORKSPACE=~/pipelines # your catalog.yaml + one folder per pipeline (a git checkout, ideally)
export STUDIO_DEPLOY_TARGET=~/pipelines/target.yaml   # where Deploy runs pipelines (see below)
make dev                            # backend :8000 + frontend :5173, both auto-reloading
```

Open <http://127.0.0.1:5173>. A workspace without a `catalog.yaml` starts with foundry's example
catalog, its schemas and SWpipeline.

### Offline demo (no token, no Docker, no Kafka)

```sh
make demo
```

The demo serves a local git repo standing in for skywalker (C# transformers with the same shape
as real ones), a workspace, and a deploy target with `Runner: none`: deploys are recorded, with
history and rollback, and print the docker commands they would run. Live data shows generated
records, labelled **demo data**. To see live updates, "push" from another terminal:

```sh
cd backend
uv run python -m foundry_studio.demo tag Base64Decoder v0.4.3        # update badge appears
uv run python -m foundry_studio.demo add Deduplicate Packets Packets   # a new card appears
make demo-reset                                                       # start over
```

## Deploying pipelines

**Deploy** saves (the pipeline and any catalog edits), then runs `deploy.py deploy` on the saved
manifest against the target in `STUDIO_DEPLOY_TARGET`, streaming its log into the deploy panel:

1. validate the manifest against the catalog;
2. check every dataset's topic exists on its cluster (read-only; it never creates one);
3. vendor each transformer at its pinned commit and build its image, or reuse one built from the
   same source (and push it, if the target names a registry);
4. run one container per transformer as a Docker Compose project, removing dropped ones;
5. record the deploy: who, when, each transformer's commit and image.

The panel lists the recorded deploys. **Roll back** runs an earlier one again, exactly as recorded;
**Stop** takes the pipeline's containers down. The top bar shows the pipeline's current deploy.

The target file (foundry's `target.example.yaml`):

```yaml
Registry: registry.gitlab.com/yume02kki/pipelinedeploys   # optional: push images here
Network: kafka                 # Docker network the containers join
SecretsDir: /etc/foundry/secrets   # <SecretRef>/username and /password, mounted read-only
StateDir: ~/.local/state/foundry   # deploy history
Runner: docker                 # or none
CheckTopics: true
```

The same commands work without Studio: `deploy.py deploy|status|history|rollback|stop`.

## GitLab token

The token is read from the `GITLAB_TOKEN` environment variable only. It is never written to disk,
logged, or put in a URL. git gets it through a credential helper that reads the variable when git
asks (`backend/foundry_studio/gitenv.py`).

| Scope | Needed for |
|---|---|
| `read_api` | Listing your projects, discovery, watching (events, tags) |
| `read_repository` | `deploy.py` cloning transformer repos at their pinned Ref |

Studio never writes to GitLab. **Save** writes the workspace; commit it with git as you like.

## Running Studio on a server

```sh
scripts/deploy_server.sh ubuntu@<host>          # from your machine, in this checkout
ssh -N -L 8000:127.0.0.1:8000 ubuntu@<host>      # then open http://localhost:8000
```

The script builds the frontend, copies the app to `/opt/foundry-studio` with rsync, installs `uv`
and the backend's dependencies, and runs it as the `foundry-studio` systemd service on
**127.0.0.1 only** (Studio has no login). Settings go in `/etc/foundry-studio.env` (mode 600):
`GITLAB_TOKEN`, `STUDIO_DEPLOY_TARGET`. The script creates that file but never sends a token.

## Configuration

| Variable | Default | |
|---|---|---|
| `GITLAB_TOKEN` | – | See above |
| `GITLAB_URL` | `https://gitlab.com` | Self-hosted GitLab works too |
| `STUDIO_TRANSFORMER_PROJECTS` | every project you're a member of | Or a comma-separated list of projects |
| `STUDIO_WORKSPACE` | `./workspace` | The catalog and the pipelines Studio edits |
| `STUDIO_DEPLOY_TARGET` | – | foundry target file; Deploy is disabled without it |
| `STUDIO_POLL_INTERVAL` | `10` | Seconds between polls |
| `STUDIO_FULL_RESCAN_INTERVAL` | `300` | Full rescan of every project even without events |
| `GITLAB_WEBHOOK_SECRET` | – | Enables `/api/webhooks/gitlab` |
| `STUDIO_FAKE_GITLAB` | – | `demo`, or a directory of local repos (tests, e2e) |
| `STUDIO_KAFKA_CLUSTERS` | – | YAML `clusters: [{match: <catalog Brokers>, connection: {…}}]`, for when the brokers are reached differently from this machine (Live data only) |
| `FOUNDRY_SECRETS_DIR` | `/var/run/secrets/foundry` | Kafka credentials for Live data: `<dir>/<SecretRef>/username` and `/password` |
| `FOUNDRY_DIR` | `./vendor/foundry` | Use another foundry checkout |

## Transformer discovery and real-time updates

Studio lists every project the token's user is a member of (re-listed every minute, so new
projects show up on their own) and scans each for folders with a **`transformer.yaml`**:

```yaml
name: XmlToJson
in: XmlPackets
out: EncodedPackets
description: Converts <packet> XML to JSON; data stays base64-encoded.
```

A transformer's versions are its `<Path>/v*` tags (newest semver first) plus the last
default-branch commit that touched its folder. Rust crates from before `transformer.yaml` are
still found; their types are inferred and marked **⚠ inferred**.

Projects with transformers are **polled** every `STUDIO_POLL_INTERVAL` seconds (the events API);
every project is rescanned every `STUDIO_FULL_RESCAN_INTERVAL`. Changes reach the browser over
Server-Sent Events (`/api/events`): `transformer.added`, `transformer.updated` (with new version
tags), `transformer.removed`. A new tag shows up within about 10–15 s.

**Webhooks** (optional, faster): when GitLab can reach the backend, add a project or group webhook
to `https://<host>/api/webhooks/gitlab` with a secret token, start the backend with
`GITLAB_WEBHOOK_SECRET=<secret>`, and enable **Push** and **Tag push** events. A push from a project
Studio hasn't listed yet makes it list projects again. Polling stays on as a safety net.

## Building pipelines

- **Transformers** tab: drag a card onto the canvas. It's added without a `Ref` (its default
  branch; the deploy record pins the commit). Pin a tag in the Inspector; a pinned node shows an
  update badge when a newer tag exists.
- **Datasets** tab: the catalog by cluster. Drag a dataset onto the canvas (or double-click it),
  register a new one (**+ Dataset**), or add a cluster.
- **Wiring:** drag from a port to a port. Compatible ports light up while dragging; a refused wire
  says why in deploy.py's words, e.g. `XmlToJson emits EncodedPackets but packets.decoded carries
  Packets`. Transformers connect only through datasets.
- **Inspector:** a transformer's version, reads, writes and consumer group; a dataset's cluster,
  schema (with its fields) and description; a connection's topic and consumer group. A dataset or
  connection also shows its **cluster's connection settings**, shared by every dataset on it
  (`SecretRef`, never a password). Catalog edits are saved with **Save**.
- **Validation** runs deploy.py on every change; the top bar shows its errors verbatim, and
  clicking one zooms to the node or connection it's about.

The manifest and the catalog are written in one **canonical form** (foundry's layout and comments,
transformers in topological order), so the same pipeline always produces the same bytes however it
was dragged and wired. Node positions go to `<Name>/<Name>.layout.json`, next to the manifest.

## Live data

Press **Live data** in the top bar. Studio follows every dataset on the canvas: connections
animate while data flows, transformers show `N in → M out/min` and how many records they dropped,
and the **Overview** lists every stage. Click to drill in: a transformer shows its input records
next to its output records (matched by Kafka key or `guid`, with a field-by-field diff), a dataset
or connection shows its messages. Every message is checked against its dataset's schema.

It's **read-only**: Studio assigns partitions under a throwaway group id, never joins a
transformer's consumer group, and never commits offsets. Connection settings come from the
catalog and are mapped exactly as the transformer runtime maps them (`peek.py`).

## Tests

```sh
make test     # backend pytest + frontend typecheck and vitest
make e2e      # Playwright, against a fresh offline demo
```

- **Backend** (`backend/tests`): the manifest and catalog round trip (byte-identical, in any drag
  and wire order, with several inputs and outputs); validation compared against the `deploy.py
  validate` CLI case by case; deploys with history, rollback and stop; discovery across every
  project; the watcher (new project, new tag, new folder, webhooks); Live data, and against a real
  broker when `STUDIO_TEST_KAFKA` is set.
- **Frontend** (`frontend/src/**/*.test.ts`): wiring rules, stages and record pairing, versions, feed health.
- **End-to-end** (`frontend/e2e`): SWpipeline draws with the right schema on each port; a wrong
  schema is refused with deploy.py's message; fan-out and fan-in; cluster edits saved to the
  catalog; a rebuilt SWpipeline is byte-identical and deploys; live tags, transformers, deploy
  history and rollback; Live data.

foundry's own tests (`vendor/foundry/tests`, `sdk/dotnet`) cover `deploy.py` and the C# SDK.

## Layout

```
backend/foundry_studio/
  app.py           FastAPI routes, SSE (events, deploy logs, live data), webhook
  foundry.py       deploy.py loader, error locator
  manifest.py      graph <-> manifest, catalog <-> catalog.yaml (canonical writers)
  validation.py    staging + deploy.load_pipeline, edge checks, dataset endpoints
  pipelines.py     the workspace: catalog, pipelines, deploys
  discovery.py     transformer.yaml folders, versions, inference for old Rust crates
  watcher.py       every member project: polling + webhooks -> event bus
  peek.py          Live data: read-only topic feeds, schema checks
  gitlab.py        GitLab REST client
  fake_gitlab.py   GitLab look-alike on local git repos (tests, demo)
  gitenv.py        git credential helper
  demo.py          offline demo + CLI
frontend/src/
  components/      Canvas, PipelineNode (transformer + dataset), TopicEdge, AssetBrowser, Datasets,
                   Inspector, TopBar, LiveData, Dialogs (deploy panel)
  lib/             rules (wiring), stages/pairing/diff, versions, layout, feed health, schema colours
  store.ts         zustand store
upstream/          merge request material for foundry and skywalker
vendor/foundry     foundry (submodule)
```
