#!/usr/bin/env bash
# Deploy Foundry Studio to a Linux server (Ubuntu/Debian) over SSH, from this checkout.
#
#   scripts/deploy_server.sh ubuntu@203.0.113.10
#
# The app has no login, so it listens on 127.0.0.1 only. Reach it through a tunnel:
#
#   ssh -N -L 8000:127.0.0.1:8000 ubuntu@203.0.113.10    # then open http://localhost:8000
#
# The GitLab token lives in /etc/foundry-studio.env on the server (root-only, mode 600).
# This script never sends it: put it there yourself (the script tells you how).
set -euo pipefail

TARGET="${1:?usage: $0 user@host}"
APP_DIR="/opt/foundry-studio"
cd "$(dirname "$0")/.."

[ -f vendor/foundry/deploy.py ] || git submodule update --init

echo "==> building the frontend"
(cd frontend && { [ -d node_modules ] || npm ci; } && npm run build)

echo "==> copying to $TARGET:$APP_DIR"
ssh "$TARGET" "sudo mkdir -p $APP_DIR && sudo chown \$(id -u):\$(id -g) $APP_DIR"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .venv --exclude .demo-gitlab \
  --exclude workspace --exclude __pycache__ --exclude 'frontend/test-results' \
  ./ "$TARGET:$APP_DIR/"

echo "==> installing on the server"
ssh "$TARGET" APP_DIR="$APP_DIR" bash -s <<'REMOTE'
set -euo pipefail
command -v git >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq git; }
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
(cd "$APP_DIR/backend" && "$UV" sync --no-dev -q)

if ! sudo test -f /etc/foundry-studio.env; then
  sudo install -m 600 /dev/null /etc/foundry-studio.env
  printf "%s\n" "# GITLAB_TOKEN=glpat-...   (read_api, read_repository)" "# STUDIO_DEPLOY_TARGET=/etc/foundry/target.yaml   (foundry target.example.yaml)" | sudo tee /etc/foundry-studio.env >/dev/null
fi
sudo chmod 600 /etc/foundry-studio.env

sudo tee /etc/systemd/system/foundry-studio.service >/dev/null <<UNIT
[Unit]
Description=Foundry Studio
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=/etc/foundry-studio.env
Environment=STUDIO_WORKSPACE=$APP_DIR/workspace
ExecStart=$APP_DIR/backend/.venv/bin/uvicorn foundry_studio.app:app --host 127.0.0.1 --port 8000
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q foundry-studio
sudo systemctl restart foundry-studio
sleep 3
systemctl is-active --quiet foundry-studio && echo "foundry-studio is running on 127.0.0.1:8000"
if ! sudo grep -q '^GITLAB_TOKEN=' /etc/foundry-studio.env; then
  echo
  echo "No GITLAB_TOKEN yet. On the server run:  sudoedit /etc/foundry-studio.env"
  echo "add the line GITLAB_TOKEN=<token>, then:  sudo systemctl restart foundry-studio"
fi
REMOTE

echo
echo "Done. Open a tunnel and browse to http://localhost:8000:"
echo "  ssh -N -L 8000:127.0.0.1:8000 $TARGET"
