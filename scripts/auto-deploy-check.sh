#!/usr/bin/env bash
# Poll origin/main and deploy if HEAD moved. Used by systemd timer on the server.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/root/www}"
BRANCH="${DEPLOY_BRANCH:-main}"
cd "$APP_ROOT"
git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/${BRANCH}")
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi
echo "[auto-deploy] $LOCAL -> $REMOTE"
exec "$APP_ROOT/scripts/deploy.sh"
