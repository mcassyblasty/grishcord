#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR_REAL="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$APP_DIR_REAL/docker-compose.yml"
PROJECT_NAME="grishcord"
ENV_FILE="$APP_DIR_REAL/.env"

compose_cmd() {
  if [[ -f "$ENV_FILE" ]]; then
    docker compose --project-directory "$APP_DIR_REAL" --env-file "$ENV_FILE" -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
  else
    docker compose --project-directory "$APP_DIR_REAL" -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
  fi
}

echo "[grishbot-restart] Recreating bot container to reload bot modules..."
compose_cmd rm -sf bot >/dev/null 2>&1 || true
compose_cmd up -d --no-deps --force-recreate bot

echo "[grishbot-restart] Bot container recreated."
compose_cmd ps bot || true
