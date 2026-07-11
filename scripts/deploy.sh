#!/usr/bin/env bash
# Production deploy for rps-battles.com
set -euo pipefail

APP_ROOT="${APP_ROOT:-/root/www}"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK_FILE="/tmp/rps-deploy.lock"

if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  echo "Deploy already running, skipping."
  exit 0
fi
trap 'rmdir "$LOCK_FILE" 2>/dev/null || true' EXIT

echo "=== RPS Battle deploy ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
cd "$APP_ROOT"

echo "1. Fetch & reset to origin/${BRANCH}..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
# Preserve production secrets and local data outside git
git reset --hard "origin/${BRANCH}"

echo "2. Backend: deps, prisma, migrate..."
cd "$APP_ROOT/backend"
if [ ! -f .env ]; then
  echo "ERROR: backend/.env missing — aborting to avoid wiping config" >&2
  exit 1
fi
npm install
npx prisma generate
npx prisma migrate deploy

echo "3. Frontend: install & web build..."
cd "$APP_ROOT/client"
npm install
npm run build

echo "4. Ensure runtime data dirs..."
mkdir -p "$APP_ROOT/data/mysql" "$APP_ROOT/data/redis"

echo "5. Restart backend service..."
systemctl restart rps-v2-backend
sleep 2
systemctl is-active --quiet rps-v2-backend

echo "6. Health check..."
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:3001/api/v2/health" | grep -q '"status":"ok"'; then
    echo "Health OK"
    echo "=== Deploy finished successfully ==="
    exit 0
  fi
  sleep 2
done

echo "ERROR: health check failed after restart" >&2
systemctl status rps-v2-backend --no-pager || true
exit 1
