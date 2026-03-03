#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SloPOS/Prune.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/prune}"
PORT="${PORT:-4173}"

log() { echo "[prune-install] $*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_deps_apt() {
  log "Installing dependencies via apt..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git ffmpeg python3 python3-pip nodejs npm
}

install_deps_dnf() {
  log "Installing dependencies via dnf..."
  sudo dnf install -y ca-certificates curl git ffmpeg python3 python3-pip nodejs npm
}

install_deps_brew() {
  log "Installing dependencies via brew..."
  brew install ffmpeg python node
}

ensure_dependencies() {
  if need_cmd apt-get; then
    install_deps_apt
  elif need_cmd dnf; then
    install_deps_dnf
  elif need_cmd brew; then
    install_deps_brew
  else
    echo "Unsupported package manager. Install manually: git, node>=20, npm, python3, pip, ffmpeg"
    exit 1
  fi
}

ensure_node20() {
  if ! need_cmd node; then
    return
  fi
  local major
  major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "${major:-0}" -lt 20 ]; then
    echo "Node.js >=20 required. Current: $(node -v)"
    exit 1
  fi
}

log "Preparing system dependencies..."
ensure_dependencies
ensure_node20

log "Cloning/updating repo in $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

log "Installing npm packages..."
npm install

log "Installing Python dependencies..."
python3 -m pip install --user -r scripts/requirements.txt

log "Preparing data directories..."
mkdir -p data/media data/uploads data/transcripts data/projects data/exports

cat <<EOF

Prune installed successfully.

Run it:
  cd "$INSTALL_DIR"
  npm run dev -w @prune/editor-web -- --host 0.0.0.0 --port $PORT

Then open:
  http://localhost:$PORT

Optional env vars:
  BITCUT_MEDIA_ROOTS
  BITCUT_UPLOAD_DIR
  BITCUT_TRANSCRIPT_DIR
  BITCUT_PROJECTS_DIR
  BITCUT_EXPORT_DIR
  BITCUT_SETTINGS_PATH
EOF
