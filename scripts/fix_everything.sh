#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="grishcord"
APP_DIR_REAL="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$APP_DIR_REAL/docker-compose.yml"
DOCKER_BIN="docker"
DOCKER_PREFIX=()

log() { printf '[fix] %s\n' "$*"; }
err() { printf '[fix][error] %s\n' "$*" >&2; }

on_error() {
  local rc=$?
  err "command failed at line $1 (exit $rc)."
  dump_diagnostics || true
  exit "$rc"
}
trap 'on_error ${LINENO}' ERR

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

docker_cmd() {
  "${DOCKER_PREFIX[@]}" "$DOCKER_BIN" "$@"
}

compose_cmd() {
  docker_cmd compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

install_prereqs() {
  local need_install=0
  for cmd in jq tar; do
    if ! require_cmd "$cmd"; then
      need_install=1
      break
    fi
  done
  if ! require_cmd curl && ! require_cmd wget; then
    need_install=1
  fi
  if ! require_cmd docker; then
    need_install=1
  fi
  if [[ "$need_install" -eq 0 ]]; then
    return
  fi

  log "installing prerequisites (docker, compose plugin, tools)..."
  export DEBIAN_FRONTEND=noninteractive
  if ! run_root apt-get update -y; then
    err "apt-get update failed. Verify APT repositories/proxy reachability, then re-run this script."
    exit 1
  fi
  if ! run_root apt-get install -y ca-certificates curl wget jq tar; then
    err "failed to install base packages (ca-certificates/curl/wget/jq/tar)."
    exit 1
  fi

  if ! require_cmd docker; then
    if ! run_root apt-get install -y docker.io; then
      err "failed to install docker.io via apt."
    fi
  fi

  if ! docker compose version >/dev/null 2>&1; then
    run_root apt-get install -y docker-compose-plugin || true
  fi

  if ! docker compose version >/dev/null 2>&1; then
    run_root apt-get install -y docker-compose-v2 || true
  fi

  require_cmd docker || { err "docker CLI missing after install attempts."; exit 1; }
  docker compose version >/dev/null 2>&1 || { err "docker compose plugin missing after install attempts."; exit 1; }
}

ensure_docker_daemon() {
  if ! run_root systemctl is-active --quiet docker; then
    log "starting docker daemon..."
    run_root systemctl enable --now docker
  fi
  run_root systemctl is-active --quiet docker || { err "docker daemon is not active."; exit 1; }
}

ensure_docker_access() {
  if docker info >/dev/null 2>&1; then
    DOCKER_PREFIX=()
    return
  fi

  if sudo docker info >/dev/null 2>&1; then
    log "docker requires sudo for this user; using sudo docker transparently."
    DOCKER_PREFIX=(sudo)
    return
  fi

  err "cannot run docker (neither direct nor via sudo)."
  exit 1
}

ensure_storage_mount() {
  [[ -d /mnt/grishcord ]] || { err "/mnt/grishcord does not exist. mount persistent storage first."; exit 1; }
  if ! mountpoint -q /mnt/grishcord; then
    err "/mnt/grishcord exists but is not a mountpoint. refusing to continue."
    exit 1
  fi
  for d in postgres uploads config; do
    run_root mkdir -p "/mnt/grishcord/$d"
    run_root chown -R "$(id -u):$(id -g)" "/mnt/grishcord/$d" || true
  done
}

cleanup_legacy_project() {
  log "cleaning possible legacy compose project named 'current' (safe/no volume deletion)..."
  docker_cmd compose -p current -f "$COMPOSE_FILE" down --remove-orphans --timeout 20 >/dev/null 2>&1 || true
}

wait_for_service() {
  local service="$1"
  local timeout_s="$2"
  local start
  start=$(date +%s)

  while true; do
    local cid status
    cid="$(compose_cmd ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$cid" ]]; then
      status="$(docker_cmd inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      if [[ "$status" == *"running"* ]]; then
        if [[ "$status" == *"healthy"* ]] || [[ "$status" != *"starting"* ]]; then
          return 0
        fi
      fi
    fi

    if (( $(date +%s) - start >= timeout_s )); then
      err "timed out waiting for service '$service'"
      return 1
    fi
    sleep 2
  done
}

get_lan_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$ip" ]]; then
    ip="127.0.0.1"
  fi
  printf '%s' "$ip"
}

get_caddy_port() {
  local mapping hostport
  mapping="$(compose_cmd port caddy 80 2>/dev/null || true)"
  if [[ -n "$mapping" ]]; then
    hostport="${mapping##*:}"
    printf '%s' "$hostport"
    return
  fi
  printf '80'
}

dump_diagnostics() {
  if ! command -v docker >/dev/null 2>&1 && [[ ${#DOCKER_PREFIX[@]} -eq 0 ]]; then
    err "docker is not installed yet; skipping compose diagnostics."
    return
  fi
  if ! docker_cmd compose version >/dev/null 2>&1; then
    err "docker compose plugin unavailable; skipping compose diagnostics."
    return
  fi

  err "compose ps output:"
  compose_cmd ps || true

  for s in caddy frontend backend; do
    err "last logs for $s:"
    compose_cmd logs --no-color --tail 200 "$s" || true
  done
}

main() {
  [[ -f "$COMPOSE_FILE" ]] || { err "compose file missing: $COMPOSE_FILE"; exit 1; }

  install_prereqs
  ensure_docker_daemon
  ensure_docker_access
  ensure_storage_mount
  cleanup_legacy_project

  log "starting stack in detached mode..."
  compose_cmd up -d --build --remove-orphans

  wait_for_service postgres 180
  wait_for_service backend 180
  wait_for_service frontend 120
  wait_for_service caddy 120

  local caddy_cid
  caddy_cid="$(compose_cmd ps -q caddy)"
  [[ -n "$caddy_cid" ]] || { err "caddy container not found"; exit 1; }

  local lan_ip caddy_port
  lan_ip="$(get_lan_ip)"
  caddy_port="$(get_caddy_port)"

  log "stack is running."
  log "Open: http://$lan_ip:$caddy_port/"
  log "Verify: docker compose -p $PROJECT_NAME -f $COMPOSE_FILE ps"
}

main "$@"
