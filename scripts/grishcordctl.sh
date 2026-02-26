#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_NAME="grishcord"
APP_DIR_REAL="$(cd "$(dirname "$0")/.." && pwd -P)"
COMPOSE_FILE="$APP_DIR_REAL/docker-compose.yml"
INSTALL_META_FILE="$APP_DIR_REAL/.grishcord-install.env"
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
  restart       Restart running services (compose restart) and wait for readiness
  stop          Stop the stack (compose down --remove-orphans)
  update-start  Pull latest images, rebuild, start, and wait for readiness
  status        Show compose status + LAN URL hint
  logs          Show recent logs for caddy/frontend/backend
  doctor        Check docker/compose/curl availability and print quick diagnostics
USAGE
}

docker_cmd() { "${DOCKER_PREFIX[@]}" "$DOCKER_BIN" "$@"; }
compose_cmd() { docker_cmd compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"; }

require_bin() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || { err "required binary missing: $bin"; exit 1; }
}

safe_load_install_meta() {
  [[ -f "$INSTALL_META_FILE" ]] || return 0
  # shellcheck disable=SC1090
  source "$INSTALL_META_FILE"
}

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

supports_compose_wait() {
  compose_cmd up --help 2>/dev/null | grep -q -- '--wait'
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

update_source_checkout() {
  safe_load_install_meta
  local method="${INSTALL_METHOD:-}"
  local repo_url="${REPO_URL:-}"
  local archive_url="${ARCHIVE_URL:-}"

  if [[ -d "$APP_DIR_REAL/.git" ]]; then
    require_bin git
    run_with_timer "git pull (source update)" git -C "$APP_DIR_REAL" pull --ff-only
    return 0
  fi

  if [[ -z "$method" ]]; then
    warn "No source update metadata found ($INSTALL_META_FILE). Skipping source code update step."
    return 0
  fi

  case "$method" in
    wget|curl)
      [[ -n "$archive_url" ]] || { warn "ARCHIVE_URL missing in $INSTALL_META_FILE; skipping source update step."; return 0; }
      require_bin tar
      local tmp_archive tmp_dir
      tmp_archive="$(mktemp /tmp/grishcord-update.XXXXXX.tar.gz)"
      tmp_dir="$(mktemp -d /tmp/grishcord-update.XXXXXX)"
      if [[ "$method" == "wget" ]]; then
        require_bin wget
        run_with_timer "source update download (wget)" wget -O "$tmp_archive" "$archive_url"
      else
        require_bin curl
        run_with_timer "source update download (curl)" curl -fL --retry 3 --connect-timeout 10 -o "$tmp_archive" "$archive_url"
      fi
      run_with_timer "source update extract" tar -xzf "$tmp_archive" -C "$tmp_dir" --strip-components=1
      run_with_timer "source update apply" cp -a "$tmp_dir"/. "$APP_DIR_REAL"/
      rm -rf "$tmp_archive" "$tmp_dir"
      ;;
    git)
      if [[ -n "$repo_url" ]]; then
        warn "Install metadata says git, but .git directory is missing; cannot safely pull."
      fi
      ;;
    *)
      warn "Unknown INSTALL_METHOD '$method' in $INSTALL_META_FILE; skipping source update step."
      ;;
  esac
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

    if [[ "$status" == exited || "$status" == dead ]]; then
      printf '\n'
      err "$service entered terminal state: $status"
      return 1
    fi

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

wait_for_http() {
  local url="$1"
  local timeout_s="$2"
  local start now elapsed
  start="$(date +%s)"
  while true; do
    now="$(date +%s)"
    elapsed=$(( now - start ))
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      printf '\n'
      log "HTTP ready: $url"
      return 0
    fi
    printf '[grishcordctl] waiting for http: %s (%ss/%ss)\r' "$url" "$elapsed" "$timeout_s"
    if (( elapsed >= timeout_s )); then
      printf '\n'
      err "timed out waiting for HTTP endpoint: $url"
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
  if supports_compose_wait; then
    run_with_timer "compose up (build/start + wait)" compose_cmd up -d --build --remove-orphans --wait --wait-timeout 240
  else
    run_with_timer "compose up (build/start)" compose_cmd up -d --build --remove-orphans
  fi
  wait_for_service postgres 240
  wait_for_service backend 240
  wait_for_service frontend 180
  wait_for_service caddy 180
  wait_for_http "http://127.0.0.1:$(get_caddy_port)/api/version" 120
  show_status
}

update_start_stack() {
  update_source_checkout
  run_with_timer "compose pull" compose_cmd pull
  if supports_compose_wait; then
    run_with_timer "compose up (update/build/start + wait)" compose_cmd up -d --build --remove-orphans --wait --wait-timeout 240
  else
    run_with_timer "compose up (update/build/start)" compose_cmd up -d --build --remove-orphans
  fi
  wait_for_service postgres 240
  wait_for_service backend 240
  wait_for_service frontend 180
  wait_for_service caddy 180
  wait_for_http "http://127.0.0.1:$(get_caddy_port)/api/version" 120
  show_status
}

restart_stack() {
  run_with_timer "compose restart" compose_cmd restart
  wait_for_service postgres 180
  wait_for_service backend 180
  wait_for_service frontend 120
  wait_for_service caddy 120
  wait_for_http "http://127.0.0.1:$(get_caddy_port)/api/version" 120
  show_status
}

doctor() {
  require_bin awk
  require_bin hostname
  require_bin curl
  ensure_docker_access
  log "docker: $(docker_cmd --version 2>/dev/null || true)"
  log "compose: $(compose_cmd version 2>/dev/null | head -n 1 || true)"
  log "compose file: $COMPOSE_FILE"
  log "compose wait support: $(supports_compose_wait && echo yes || echo no)"
  log "lan ip: $(get_lan_ip)"
  log "caddy port: $(get_caddy_port)"
  compose_cmd ps || true
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
  require_bin curl

  case "$cmd" in
    start) start_stack ;;
    restart) restart_stack ;;
    stop) stop_stack ;;
    update-start) update_start_stack ;;
    status) show_status ;;
    logs) show_logs ;;
    doctor) doctor ;;
    *) err "unknown command: $cmd"; usage; exit 2 ;;
  esac
}

main "$@"
