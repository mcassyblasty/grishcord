#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="grishcord"
APP_DIR_REAL="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$APP_DIR_REAL/docker-compose.yml"
DOCKER_BIN="docker"
DOCKER_PREFIX=()

log() { printf '[grishcordctl] %s\n' "$*"; }
warn() { printf '[grishcordctl][warn] %s\n' "$*" >&2; }
err() { printf '[grishcordctl][error] %s\n' "$*" >&2; }

usage() {
  cat <<USAGE
Usage: ./scripts/grishcordctl.sh <command>

Commands:
  start         Build + start services in detached mode, then wait for readiness
  stop          Stop the stack (compose down --remove-orphans)
  update-start  Pull latest images, rebuild, start, and wait for readiness
  status        Show compose status + LAN URL hint
  logs          Show recent logs for caddy/frontend/backend
USAGE
}

docker_cmd() { "${DOCKER_PREFIX[@]}" "$DOCKER_BIN" "$@"; }
compose_cmd() { docker_cmd compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"; }

ensure_docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=()
    return
  fi
  if sudo docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=(sudo)
    log "docker requires sudo for this user; using sudo transparently."
    return
  fi
  err "docker is not accessible for this user."
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

run_with_timer() {
  local title="$1"; shift
  local start now elapsed
  start="$(date +%s)"
  log "$title"
  (
    "$@" \
      > >(stdbuf -oL sed 's/^/[compose] /') \
      2> >(stdbuf -oL sed 's/^/[compose][err] /' >&2)
  ) &
  local pid=$!
  while kill -0 "$pid" >/dev/null 2>&1; do
    now="$(date +%s)"
    elapsed=$(( now - start ))
    printf '[grishcordctl] %s ... %ss elapsed\r' "$title" "$elapsed"
    sleep 1
  done
  wait "$pid"
  local rc=$?
  printf '\n'
  if [[ "$rc" -ne 0 ]]; then
    err "$title failed (exit $rc)."
    return "$rc"
  fi
  now="$(date +%s)"
  elapsed=$(( now - start ))
  log "$title completed in ${elapsed}s."
}

wait_for_service() {
  local service="$1"
  local timeout_s="$2"
  local start now elapsed cid status
  start="$(date +%s)"
  while true; do
    now="$(date +%s)"
    elapsed=$(( now - start ))
    cid="$(compose_cmd ps -q "$service" 2>/dev/null || true)"
    status="(missing)"
    if [[ -n "$cid" ]]; then
      status="$(docker_cmd inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    fi
    printf '[grishcordctl] waiting for %s: %s (%ss/%ss)\r' "$service" "$status" "$elapsed" "$timeout_s"

    if [[ "$status" == running/healthy || "$status" == running || "$status" == running/none ]]; then
      printf '\n'
      log "$service ready: $status"
      return 0
    fi
    if (( elapsed >= timeout_s )); then
      printf '\n'
      err "timed out waiting for $service (last status: $status)."
      return 1
    fi
    sleep 1
  done
}

show_status() {
  compose_cmd ps
  local lan_ip caddy_port
  lan_ip="$(get_lan_ip)"
  caddy_port="$(get_caddy_port)"
  log "LAN URL: http://$lan_ip:$caddy_port/"
}

show_logs() {
  compose_cmd logs --no-color --tail 200 caddy frontend backend
}

start_stack() {
  run_with_timer "compose up (build/start)" compose_cmd up -d --build --remove-orphans
  wait_for_service postgres 240
  wait_for_service backend 240
  wait_for_service frontend 180
  wait_for_service caddy 180
  show_status
}

update_start_stack() {
  run_with_timer "compose pull" compose_cmd pull
  run_with_timer "compose up (update/build/start)" compose_cmd up -d --build --remove-orphans
  wait_for_service postgres 240
  wait_for_service backend 240
  wait_for_service frontend 180
  wait_for_service caddy 180
  show_status
}

stop_stack() {
  run_with_timer "compose down" compose_cmd down --remove-orphans --timeout 30
  log "stack stopped."
}

main() {
  [[ -f "$COMPOSE_FILE" ]] || { err "compose file missing: $COMPOSE_FILE"; exit 1; }

  local cmd="${1:-}"
  case "$cmd" in
    ""|-h|--help|help) usage; return 0 ;;
  esac

  ensure_docker_access

  case "$cmd" in
    start) start_stack ;;
    stop) stop_stack ;;
    update-start) update_start_stack ;;
    status) show_status ;;
    logs) show_logs ;;
    *) err "unknown command: $cmd"; usage; exit 2 ;;
  esac
}

main "$@"
