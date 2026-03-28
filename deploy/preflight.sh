#!/usr/bin/env bash
# preflight.sh — Check server state before deploying wb-scene-viewer.
#
# Connects via SSH and inspects the server without making any changes.
# Run this before the first deploy (or any time you want to verify server state).
#
# Usage:
#   bash deploy/preflight.sh <ssh-host>
#
# Example:
#   bash deploy/preflight.sh linode

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <ssh-host>"
  exit 1
fi

SSH_HOST="$1"
REMOTE_DIR=/opt/wb-scene-viewer
SERVICE_NAME=wb-scene-viewer
NGINX_CONF=/etc/nginx/sites-available/${SERVICE_NAME}.conf
DATA_ZIP=$REMOTE_DIR/guessing-scene.zip

echo "==> Preflight check for $SSH_HOST"
echo ""

ssh "$SSH_HOST" bash <<EOF
set -uo pipefail

PASS=0
WARN=0
FAIL=0

ok()   { echo "  [OK]   \$1"; PASS=\$((PASS+1)); }
warn() { echo "  [WARN] \$1"; WARN=\$((WARN+1)); }
fail() { echo "  [FAIL] \$1"; FAIL=\$((FAIL+1)); }

echo "--- System ---"
if python3 --version &>/dev/null; then
  PYVER=\$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  ok "python3 available: \$(python3 --version 2>&1)"
  if python3 -m ensurepip --version &>/dev/null; then
    ok "python3-venv available"
  else
    warn "python3-venv not installed — deploy.sh will run: apt-get install python\${PYVER}-venv"
  fi
else
  fail "python3 not found"
fi
node --version   2>/dev/null && ok "node available: \$(node --version)" || fail "node not found"
npm --version    2>/dev/null && ok "npm available: \$(npm --version)" || fail "npm not found"

echo ""
echo "--- nginx ---"
if systemctl is-active --quiet nginx 2>/dev/null; then
  ok "nginx is running"
else
  fail "nginx is not running"
fi

if nginx -t 2>/dev/null; then
  ok "nginx config is valid"
else
  fail "nginx config has errors (run: sudo nginx -t)"
fi

if [ -f "$NGINX_CONF" ]; then
  warn "nginx config already exists at $NGINX_CONF — deploy.sh will skip installing it"
  echo "         (this is fine for updates; check the file if it's a first install)"
else
  ok "no existing nginx config at $NGINX_CONF — deploy.sh will install it fresh"
fi

echo ""
echo "--- Port 8421 ---"
if ss -tlnp 2>/dev/null | grep -q ':8421'; then
  warn "port 8421 is already in use: \$(ss -tlnp | grep ':8421')"
  echo "         (if it's a previous wb-scene-viewer, deploy.sh will restart it)"
else
  ok "port 8421 is free"
fi

echo ""
echo "--- Service ---"
if systemctl is-active --quiet $SERVICE_NAME 2>/dev/null; then
  warn "$SERVICE_NAME service is already running — deploy.sh will restart it"
elif systemctl list-unit-files --quiet $SERVICE_NAME.service 2>/dev/null | grep -q $SERVICE_NAME; then
  ok "$SERVICE_NAME service is installed but not running"
else
  ok "$SERVICE_NAME service not yet installed — deploy.sh will install it"
fi

echo ""
echo "--- Deploy directory ---"
if [ -d "$REMOTE_DIR" ]; then
  ok "$REMOTE_DIR exists"
else
  ok "$REMOTE_DIR does not exist yet — deploy.sh will create it"
fi

if [ -f "$DATA_ZIP" ]; then
  SIZE=\$(du -h "$DATA_ZIP" | cut -f1)
  ok "data zip found at $DATA_ZIP (\$SIZE)"
else
  fail "data zip NOT found at $DATA_ZIP"
  echo "         It should be synced automatically by rsync-to-server.sh"
fi

echo ""
echo "--- Summary ---"
echo "  Passed: \$PASS   Warnings: \$WARN   Failed: \$FAIL"
echo ""

if [ "\$FAIL" -gt 0 ]; then
  echo "  Fix the FAIL items above before deploying."
  exit 1
elif [ "\$WARN" -gt 0 ]; then
  echo "  Warnings are non-blocking — review them, then deploy when ready."
  exit 0
else
  echo "  All checks passed. Ready to deploy:"
  echo "  bash deploy/rsync-to-server.sh $SSH_HOST --deploy"
  exit 0
fi
EOF
