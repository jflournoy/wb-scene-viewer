#!/usr/bin/env bash
# deploy.sh — Install or update wb-scene-viewer on the Linode server.
#
# Run on the server after rsync-to-server.sh has synced the project:
#
#   sudo bash /opt/wb-scene-viewer/deploy/deploy.sh
#
# What it does:
#   1. Installs python3-venv if missing
#   2. Creates a Python venv and installs dependencies
#   3. Builds the frontend into dist/
#   4. Sets file ownership
#   5. Installs and enables the systemd service
#   6. Restarts the service and reloads nginx
#
# Assumptions:
#   - nginx is already installed and running
#   - The location blocks from nginx-wb-scene-viewer.conf have already been
#     manually added to /etc/nginx/sites-enabled/hcpd (one-time setup)
#   - Python 3.10+ is available as `python3`
#   - Node.js / npm is available
#   - SSL is already configured via certbot for hcpd.johnflournoy.science
#
# To update after code changes:
#   bash deploy/rsync-to-server.sh <ssh-host> --deploy

set -euo pipefail

DEPLOY_DIR=/opt/wb-scene-viewer
SERVICE_NAME=wb-scene-viewer
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Deploying from $PROJECT_DIR"

# 1. Install python3-venv if missing
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if ! python3 -m ensurepip --version &>/dev/null; then
  echo "==> Installing python${PYTHON_VERSION}-venv..."
  apt-get install -y "python${PYTHON_VERSION}-venv"
fi

# 2. Set up Python venv
echo "==> Setting up Python venv..."
python3 -m venv "$DEPLOY_DIR/.venv"
"$DEPLOY_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$DEPLOY_DIR/.venv/bin/pip" install --quiet -r "$DEPLOY_DIR/requirements.txt"

# 3. Build frontend
echo "==> Building frontend..."
cd "$DEPLOY_DIR/frontend"
npm install --silent
npm run build
cd "$DEPLOY_DIR"

# 4. Set ownership
chown -R www-data:www-data "$DEPLOY_DIR"

# 5. Install systemd service
echo "==> Installing systemd service..."
cp "$DEPLOY_DIR/deploy/wb-scene-viewer.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# 6. Test nginx config
nginx -t

# 7. Restart service and reload nginx
echo "==> Starting service..."
systemctl restart "$SERVICE_NAME"
systemctl reload nginx

echo ""
echo "==> Done. Check status with:"
echo "    systemctl status $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"
echo ""
if [ ! -f "$DEPLOY_DIR/guessing-scene.zip" ]; then
  echo "WARNING: $DEPLOY_DIR/guessing-scene.zip not found — service will fail to start."
  echo "         Run rsync-to-server.sh from your local machine to sync it."
fi
