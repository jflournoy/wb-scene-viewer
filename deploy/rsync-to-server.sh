#!/usr/bin/env bash
# rsync-to-server.sh — Sync project to server and optionally run deploy.sh
#
# Usage:
#   bash deploy/rsync-to-server.sh <ssh-host> [--dry-run] [--deploy]
#
# <ssh-host> must match a Host entry in ~/.ssh/config
#
# Flags (can be combined, order doesn't matter):
#   --dry-run   Show what rsync would transfer without touching the server
#   --deploy    After syncing, SSH in and run deploy.sh with sudo
#
# Examples:
#   bash deploy/rsync-to-server.sh linode --dry-run
#   bash deploy/rsync-to-server.sh linode
#   bash deploy/rsync-to-server.sh linode --deploy

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <ssh-host> [--dry-run] [--deploy]"
  exit 1
fi

SSH_HOST="$1"
shift

DRY_RUN=0
RUN_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --deploy)  RUN_DEPLOY=1 ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

REMOTE_DIR=/opt/wb-scene-viewer
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RSYNC_FLAGS=(-av --delete
  --exclude='.venv/'
  --exclude='node_modules/'
  --exclude='frontend/node_modules/'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.git/'
  --exclude='dist/'
)

if [ "$DRY_RUN" = "1" ]; then
  echo "==> DRY RUN — showing what would be transferred to $SSH_HOST:$REMOTE_DIR"
  echo "==> (no files will be written)"
  echo ""
  rsync "${RSYNC_FLAGS[@]}" --dry-run "$PROJECT_DIR/" "$SSH_HOST:$REMOTE_DIR/"
  echo ""
  echo "==> Dry run complete. Re-run without --dry-run to sync for real."
  exit 0
fi

echo "==> Syncing $PROJECT_DIR to $SSH_HOST:$REMOTE_DIR"
rsync "${RSYNC_FLAGS[@]}" "$PROJECT_DIR/" "$SSH_HOST:$REMOTE_DIR/"
echo "==> Sync complete."

if [ "$RUN_DEPLOY" = "1" ]; then
  echo "==> Running deploy.sh on $SSH_HOST..."
  ssh "$SSH_HOST" "sudo bash $REMOTE_DIR/deploy/deploy.sh"
else
  echo ""
  echo "To deploy, run:"
  echo "  ssh $SSH_HOST 'sudo bash $REMOTE_DIR/deploy/deploy.sh'"
  echo "Or re-run with --deploy:"
  echo "  $0 $SSH_HOST --deploy"
fi
