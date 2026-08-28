#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SloPOS/Prune.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/prune}"
PORT="${PORT:-4173}"
# Pin installs to a released tag. Override with PRUNE_REF=main to track
# the development branch, or PRUNE_REF=v1.2.3 for a specific release.
PRUNE_REF="${PRUNE_REF:-v1.0.0}"

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

# Resolve the ref to install. Falls back to the default branch when the
# pinned tag does not exist yet, so the installer never hard-fails on a
# repo that has not cut that release.
resolve_ref() {
  if git ls-remote --exit-code --tags "$REPO_URL" "refs/tags/$PRUNE_REF" >/dev/null 2>&1; then
    echo "$PRUNE_REF"
    return
  fi
  if git ls-remote --exit-code --heads "$REPO_URL" "refs/heads/$PRUNE_REF" >/dev/null 2>&1; then
    echo "$PRUNE_REF"
    return
  fi
  log "Ref '$PRUNE_REF' not found upstream; falling back to the default branch." >&2
  echo "HEAD"
}

log "Preparing system dependencies..."
ensure_dependencies
ensure_node20

RESOLVED_REF="$(resolve_ref)"
log "Installing ref: $RESOLVED_REF"

log "Cloning/updating repo in $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --tags --force origin
  if [ "$RESOLVED_REF" = "HEAD" ]; then
    git -C "$INSTALL_DIR" checkout --quiet "$(git -C "$INSTALL_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git -C "$INSTALL_DIR" checkout --quiet --force "$RESOLVED_REF"
  fi
else
  if [ "$RESOLVED_REF" = "HEAD" ]; then
    git clone "$REPO_URL" "$INSTALL_DIR"
  else
    git clone --branch "$RESOLVED_REF" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

log "Installing npm packages..."
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

log "Installing Python dependencies..."
python3 -m pip install --user -r scripts/requirements.txt

log "Building the web app..."
npm run build

log "Preparing data directories..."
mkdir -p data/media data/uploads data/transcripts data/projects data/exports

cat <<EOF

Prune installed successfully.

Run it:
  cd "$INSTALL_DIR"
  npm run start:prod

Then open:
  http://localhost:$PORT

Prune binds to 127.0.0.1 by default. Its API is unauthenticated and can
browse the host filesystem, so only expose it on a network you trust:

  HOST=0.0.0.0 npm run start:prod

Optional env vars:
  PORT
  PRUNE_INBOX_ROOT
  PRUNE_ARCHIVE_ROOT
  PRUNE_UPLOAD_DIR
  PRUNE_TRANSCRIPT_DIR
  PRUNE_PROJECTS_DIR
  PRUNE_EXPORT_DIR
  PRUNE_SETTINGS_PATH
EOF
