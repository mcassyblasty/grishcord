#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=""
ENV_FILE=""
INSTALL_ENV_FILE=""
COOKIE_JAR="$(mktemp /tmp/grishcord-install-cookie.XXXXXX)"
trap 'rm -f "$COOKIE_JAR"' EXIT

log(){ printf '[installGrishcord] %s\n' "$*"; }
warn(){ printf '[installGrishcord][warn] %s\n' "$*" >&2; }
err(){ printf '[installGrishcord][error] %s\n' "$*" >&2; }

prompt() {
  local label="$1"; local def="${2:-}"; local out
  if [[ -n "$def" ]]; then read -r -p "$label [$def]: " out || true; printf '%s' "${out:-$def}";
  else read -r -p "$label: " out || true; printf '%s' "$out"; fi
}

prompt_secret() {
  local label="$1"; local out
  read -r -s -p "$label: " out || true
  printf '\n' >&2
  printf '%s' "$out"
}

require_bin(){ command -v "$1" >/dev/null 2>&1 || { err "missing required binary: $1"; exit 1; }; }

is_repo_dir() {
  local d="$1"
  [[ -n "$d" && -f "$d/docker-compose.yml" && -d "$d/backend" && -d "$d/scripts" ]]
}

provision_repo_checkout() {
  local default_target="${HOME:-$PWD}/grishcord"
  local target source_mode source

  warn "Grishcord repo root was not found automatically."
  target="$(prompt 'Where should Grishcord be located?' "$default_target")"
  mkdir -p "$target"

  if is_repo_dir "$target"; then
    APP_DIR="$target"
    ENV_FILE="$APP_DIR/.env"
    INSTALL_ENV_FILE="$APP_DIR/.install.env"
    return 0
  fi

  source_mode="$(prompt 'Repo source (local-archive/git)' 'local-archive')"
  case "$source_mode" in
    local-archive)
      source="$(prompt 'Path to Grishcord archive (.zip or .tar.gz)' "$PWD/grishcordgood.zip")"
      [[ -f "$source" ]] || { err "archive file not found: $source"; exit 1; }
      if [[ "$source" == *.zip ]]; then
        require_bin unzip
        unzip -oq "$source" -d "$target"
      else
        require_bin tar
        tar -xzf "$source" -C "$target"
      fi
      ;;
    git)
      require_bin git
      source="$(prompt 'Grishcord git URL' 'https://github.com/example/grishcord.git')"
      if [[ -d "$target/.git" ]]; then
        git -C "$target" pull --ff-only
      else
        if [[ -n "$(find "$target" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
          warn "Target directory not empty; using existing contents."
        else
          git clone --depth 1 "$source" "$target"
        fi
      fi
      ;;
    *) err "invalid repo source: $source_mode"; exit 1 ;;
  esac

  if ! is_repo_dir "$target"; then
    local nested
    nested="$(find "$target" -mindepth 1 -maxdepth 2 -type f -name docker-compose.yml -printf '%h
' | head -n1 || true)"
    if [[ -n "$nested" ]] && is_repo_dir "$nested"; then
      target="$nested"
    fi
  fi

  is_repo_dir "$target" || { err "Could not prepare a valid Grishcord repo at $target"; exit 1; }
  APP_DIR="$target"
  ENV_FILE="$APP_DIR/.env"
  INSTALL_ENV_FILE="$APP_DIR/.install.env"
}

resolve_app_dir() {
  local script_dir pwd_dir home_dir candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  pwd_dir="$(pwd)"
  home_dir="${HOME:-}/grishcord"

  for candidate in "$script_dir" "$pwd_dir" "$home_dir"; do
    [[ -n "$candidate" ]] || continue
    if is_repo_dir "$candidate"; then
      APP_DIR="$candidate"
      ENV_FILE="$APP_DIR/.env"
      INSTALL_ENV_FILE="$APP_DIR/.install.env"
      return 0
    fi
  done

  provision_repo_checkout
}

load_install_env(){ [[ -f "$INSTALL_ENV_FILE" ]] && source "$INSTALL_ENV_FILE" || true; }

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    log "Created $ENV_FILE from .env.example"
  fi
}

get_env_key() {
  local key="$1"
  awk -F= -v k="$key" '$1==k {print substr($0,index($0,"=")+1)}' "$ENV_FILE" | tail -n 1
}

set_env_key() {
  local key="$1"; local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s#^${key}=.*#${key}=${value//#/\\#}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

write_install_env() {
  cat > "$INSTALL_ENV_FILE" <<ENV
ROOT_ADMIN_USERNAME=$ROOT_ADMIN_USERNAME
ROOT_ADMIN_DISPLAY_NAME=$ROOT_ADMIN_DISPLAY_NAME
EXISTING_ADMIN_DB=$EXISTING_ADMIN_DB
ENABLE_AI=$ENABLE_AI
BOT_USERNAME=${BOT_USERNAME:-}
BOT_DISPLAY_NAME=${BOT_DISPLAY_NAME:-}
BOT_COLOR=${BOT_COLOR:-}
ENV
  chmod 600 "$INSTALL_ENV_FILE" 2>/dev/null || true
}

wait_http_ok() {
  local url="$1"; local tries="${2:-60}"; local i
  for ((i=1; i<=tries; i+=1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

json_field() {
  local field="$1"
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

bootstrap_root_admin() {
  local base_url="$1"
  log "Bootstrapping root admin account"

  local payload
  payload=$(printf '{"username":"%s","displayName":"%s","password":"%s"}' "$ROOT_ADMIN_USERNAME" "$ROOT_ADMIN_DISPLAY_NAME" "$ROOT_ADMIN_PASSWORD")
  local status
  status=$(curl -sS -o /tmp/grish_bootstrap.json -w '%{http_code}' -H 'content-type: application/json' -X POST "$base_url/api/bootstrap/root" -d "$payload" || true)

  if [[ "$status" == "200" ]]; then
    log "Root admin created successfully."
    return 0
  fi

  if [[ "$status" == "409" ]]; then
    log "Root admin bootstrap already initialized; continuing with login verification."
    return 0
  fi

  err "root bootstrap failed (HTTP $status): $(cat /tmp/grish_bootstrap.json 2>/dev/null || true)"
  exit 1
}

login_admin() {
  local base_url="$1"
  local payload
  payload=$(printf '{"username":"%s","password":"%s"}' "$ROOT_ADMIN_USERNAME" "$ROOT_ADMIN_PASSWORD")
  local status
  status=$(curl -sS -o /tmp/grish_login.json -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/login" -d "$payload" || true)
  [[ "$status" == "200" ]] || { err "admin login failed (HTTP $status): $(cat /tmp/grish_login.json 2>/dev/null || true)"; exit 1; }
}

create_invite_key() {
  local base_url="$1"
  local status
  status=$(curl -sS -o /tmp/grish_invite.json -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/admin/invites" -d '{}' || true)
  [[ "$status" == "200" ]] || { err "invite creation failed (HTTP $status): $(cat /tmp/grish_invite.json 2>/dev/null || true)"; exit 1; }
  cat /tmp/grish_invite.json | json_field inviteKey
}

register_user_with_invite() {
  local base_url="$1" invite="$2" username="$3" display="$4" password="$5"
  local payload status
  payload=$(printf '{"inviteToken":"%s","username":"%s","displayName":"%s","password":"%s"}' "$invite" "$username" "$display" "$password")
  status=$(curl -sS -o /tmp/grish_register.json -w '%{http_code}' -H 'content-type: application/json' -X POST "$base_url/api/register" -d "$payload" || true)
  [[ "$status" == "200" ]] || {
    if grep -q 'invalid_invite' /tmp/grish_register.json 2>/dev/null; then
      err "registration failed due to invalid invite"
    else
      warn "user registration returned HTTP $status: $(cat /tmp/grish_register.json 2>/dev/null || true)"
    fi
    return 1
  }
  return 0
}

ensure_user_profile() {
  local base_url="$1" username="$2" password="$3" display="$4" color="$5"
  local login_payload
  login_payload=$(printf '{"username":"%s","password":"%s"}' "$username" "$password")
  curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/login" -d "$login_payload" >/dev/null
  curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X PATCH "$base_url/api/me/profile" -d "$(printf '{"displayName":"%s","displayColor":"%s"}' "$display" "$color")" >/dev/null || true
}

ufw_allow_docker_to_ollama() {
  command -v ufw >/dev/null 2>&1 || { warn "ufw not installed; skipping firewall updates"; return 0; }
  local ufw_active="$(ufw status 2>/dev/null | head -n1 | tr '[:upper:]' '[:lower:]')"
  [[ "$ufw_active" == *active* ]] || { warn "ufw not active; skipping firewall updates"; return 0; }

  local answer
  read -r -p "UFW detected/enabled — apply recommended rules for Ollama access from Docker? [Y/n]: " answer
  answer="${answer:-Y}"
  [[ "$answer" =~ ^[Yy]$ ]] || return 0

  local net="grishcord_default"
  local subnets
  subnets="$(docker network inspect "$net" --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' 2>/dev/null || true)"
  if [[ -z "$subnets" ]]; then
    warn "Could not derive Docker network subnet for $net; skipping ufw rule changes"
    return 0
  fi
  while IFS= read -r subnet; do
    [[ -z "$subnet" ]] && continue
    sudo ufw allow from "$subnet" to any port 11434 proto tcp comment 'grishcord-ollama-docker' >/dev/null || true
    log "Applied UFW allow rule: $subnet -> tcp/11434"
  done <<< "$subnets"
  warn "Firewall guidance: keep tcp/11434 restricted to local/docker networks; do not expose publicly."
}

configure_ai() {
  local base_url="$1"
  read -r -p "Do you want to install and enable AI (Ollama + GrishBot)? [y/N]: " ans
  ans="${ans:-N}"
  if [[ ! "$ans" =~ ^[Yy]$ ]]; then ENABLE_AI="false"; return 0; fi
  ENABLE_AI="true"

  "$APP_DIR/scripts/ollamactrl.sh" install

  BOT_USERNAME="$(prompt 'Bot username' "${BOT_USERNAME:-grishbot}")"
  BOT_DISPLAY_NAME="$(prompt 'Bot display name' "${BOT_DISPLAY_NAME:-Grish Bot}")"
  BOT_COLOR="$(prompt 'Bot color (#RRGGBB)' "${BOT_COLOR:-#7A5CFF}")"
  BOT_PASSWORD="$(prompt_secret 'Bot password')"

  login_admin "$base_url"
  invite_key="$(create_invite_key "$base_url")"
  if ! register_user_with_invite "$base_url" "$invite_key" "$BOT_USERNAME" "$BOT_DISPLAY_NAME" "$BOT_PASSWORD"; then
    warn "Bot user may already exist; continuing with profile update/login checks."
  fi

  ensure_user_profile "$base_url" "$BOT_USERNAME" "$BOT_PASSWORD" "$BOT_DISPLAY_NAME" "$BOT_COLOR"

  set_env_key BOT_USERNAME "$BOT_USERNAME"
  set_env_key BOT_PASSWORD "$BOT_PASSWORD"
  set_env_key BOT_DISPLAY_NAME "$BOT_DISPLAY_NAME"
  set_env_key BOT_COLOR "$BOT_COLOR"
  set_env_key OLLAMA_BASE_URL "http://host.docker.internal:11434"

  ufw_allow_docker_to_ollama

  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build bot
  if ! docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" exec -T bot sh -lc 'wget -qO- "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1 || curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null'; then
    warn "Bot container cannot reach Ollama yet. Check host firewall rules for docker subnet -> tcp/11434."
  else
    log "Bot container connectivity to Ollama verified."
  fi
}

main() {
  require_bin docker
  require_bin curl
  resolve_app_dir
  log "Using repo directory: $APP_DIR"

  load_install_env
  ensure_env_file

  local current_admin_env
  current_admin_env="$(get_env_key ADMIN_USERNAME || true)"
  EXISTING_ADMIN_DB="$(prompt 'Is there already an admin account in the existing DB? (y/N)' "${EXISTING_ADMIN_DB:-N}")"

  if [[ "$EXISTING_ADMIN_DB" =~ ^[Yy]$ ]]; then
    ROOT_ADMIN_USERNAME="$(prompt 'Existing admin username' "${ROOT_ADMIN_USERNAME:-${current_admin_env:-rootadmin}}")"
    ROOT_ADMIN_DISPLAY_NAME="${ROOT_ADMIN_DISPLAY_NAME:-$ROOT_ADMIN_USERNAME}"
    ROOT_ADMIN_PASSWORD="$(prompt_secret 'Existing admin password')"
    if [[ -z "$current_admin_env" ]]; then
      set_env_key ADMIN_USERNAME "$ROOT_ADMIN_USERNAME"
      warn "ADMIN_USERNAME was not set in .env; initialized to $ROOT_ADMIN_USERNAME"
    fi
  else
    ROOT_ADMIN_USERNAME="$(prompt 'Root admin username' "${ROOT_ADMIN_USERNAME:-${current_admin_env:-rootadmin}}")"
    ROOT_ADMIN_DISPLAY_NAME="$(prompt 'Root admin display name' "${ROOT_ADMIN_DISPLAY_NAME:-Root Admin}")"
    ROOT_ADMIN_PASSWORD="$(prompt_secret 'Root admin password')"
    set_env_key ADMIN_USERNAME "$ROOT_ADMIN_USERNAME"
  fi

  log "Starting/upgrading compose stack"
  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build --remove-orphans

  if ! wait_http_ok "http://127.0.0.1:3000/health" 80; then
    err "Backend health check failed at http://127.0.0.1:3000/health"
    exit 1
  fi

  if [[ "$EXISTING_ADMIN_DB" =~ ^[Yy]$ ]]; then
    log "Skipping root bootstrap because existing DB admin was selected."
  else
    bootstrap_root_admin "http://127.0.0.1:3000"
  fi
  login_admin "http://127.0.0.1:3000"

  configure_ai "http://127.0.0.1:3000"

  write_install_env

  cat <<SUMMARY

Install complete.
- Backend health: OK
- Root admin username: $ROOT_ADMIN_USERNAME (protected by ADMIN_USERNAME server-side checks)
- Existing admin DB mode: $EXISTING_ADMIN_DB
- AI enabled: $ENABLE_AI

Next steps:
1) Open your Grishcord URL and log in as root admin.
2) Re-run installer any time: ./install_grishcord.sh (idempotent config in .install.env).
3) Keep .env and .install.env private; they are local runtime config files.
SUMMARY
}

main "$@"
