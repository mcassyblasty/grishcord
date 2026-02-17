#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="grishcord"
APP_DIR_REAL="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$APP_DIR_REAL/docker-compose.yml"
DOCKER_BIN="docker"
DOCKER_PREFIX=()

log() { printf '[run] %s\n' "$*"; }
err() { printf '[run][error] %s\n' "$*" >&2; }

docker_cmd() {
  "${DOCKER_PREFIX[@]}" "$DOCKER_BIN" "$@"
}

compose_cmd() {
  docker_cmd compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

ensure_docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=()
    return
  fi
  if sudo docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=(sudo)
    return
  fi
  err "docker is not accessible (try scripts/fix_everything.sh first)."
  exit 1
}

get_lan_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$ip" ]] || ip="127.0.0.1"
  printf '%s' "$ip"
}

get_caddy_port() {
  local mapping
  mapping="$(compose_cmd port caddy 80 2>/dev/null || true)"
  if [[ -n "$mapping" ]]; then
    printf '%s' "${mapping##*:}"
  else
    printf '80'
  fi
}

main() {
  [[ -f "$COMPOSE_FILE" ]] || { err "compose file missing: $COMPOSE_FILE"; exit 1; }
  ensure_docker_access

  compose_cmd up -d --build --remove-orphans

  local lan_ip caddy_port
  lan_ip="$(get_lan_ip)"
  caddy_port="$(get_caddy_port)"

  log "Open: http://$lan_ip:$caddy_port/"
  log "If unreachable, run:"
  log "  docker compose -p $PROJECT_NAME -f $COMPOSE_FILE ps"
  log "  docker compose -p $PROJECT_NAME -f $COMPOSE_FILE logs --tail 200 caddy frontend backend"
}

main "$@"
