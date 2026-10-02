#!/usr/bin/env bash
# Backend (FastAPI, :8000, auto-reload) + frontend (Vite, :5173) in one terminal. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f vendor/scripts/manifest/manifest.py ] || git submodule update --init
[ -d frontend/node_modules ] || (cd frontend && npm ci)
(cd backend && uv sync -q)

if [ -z "${STUDIO_FAKE_GITLAB:-}" ] && [ -z "${GITLAB_TOKEN:-}" ]; then
  echo "warning: GITLAB_TOKEN is not set: only public projects are readable, and transformers are only" >&2
  echo "         found in STUDIO_TRANSFORMER_PROJECTS. Export it, or run 'make demo' for the offline demo." >&2
fi

PORT="${STUDIO_PORT:-8000}"
trap 'kill 0' EXIT INT TERM
(cd backend && uv run uvicorn foundry_studio.app:app --reload --host 127.0.0.1 --port "$PORT") &
(cd frontend && STUDIO_BACKEND="http://127.0.0.1:$PORT" npx vite --host 127.0.0.1 --port "${STUDIO_FRONTEND_PORT:-5173}") &
echo "Foundry Studio: http://127.0.0.1:${STUDIO_FRONTEND_PORT:-5173}"
wait
