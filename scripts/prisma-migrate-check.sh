#!/usr/bin/env bash
# Ensure schema changes are migrated automatically during deploy.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/root/www}"
BACKEND_DIR="$APP_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set in $ENV_FILE" >&2
  exit 1
fi

SHADOW_DATABASE_URL="${SHADOW_DATABASE_URL:-${DATABASE_URL%/*}/rps_db_v2_shadow}"

cd "$BACKEND_DIR"

echo "2a. Ensure Prisma shadow database exists..."
SHADOW_DB_NAME="${SHADOW_DATABASE_URL##*/}"
SHADOW_DB_NAME="${SHADOW_DB_NAME%%\?*}"
MYSQL_ROOT_PASSWORD="$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.password));")"
docker exec rps_mysql_v2 mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE DATABASE IF NOT EXISTS \`${SHADOW_DB_NAME}\`;" >/dev/null 2>&1

echo "2b. Check schema.prisma is fully covered by migration files..."
if ! npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code; then
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "ERROR: schema.prisma has database changes without a migration." >&2
    echo "Create one locally, commit it, and push:" >&2
    echo "  cd backend && npx prisma migrate dev --name <change_name>" >&2
    exit 1
  fi
  echo "ERROR: prisma migrate diff failed with exit code $status" >&2
  exit "$status"
fi

echo "2c. Apply pending database migrations..."
npx prisma migrate deploy

echo "2d. Verify database matches schema.prisma..."
if ! npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code; then
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "ERROR: database schema still differs from schema.prisma after migrate deploy." >&2
    exit 1
  fi
  echo "ERROR: post-migrate schema verification failed with exit code $status" >&2
  exit "$status"
fi

echo "Database migrations are up to date."