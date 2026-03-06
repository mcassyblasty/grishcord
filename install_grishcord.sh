#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=""
ENV_FILE=""
INSTALL_ENV_FILE=""
COOKIE_JAR="$(mktemp /tmp/grishcord-install-cookie.XXXXXX)"
AI_SETUP_STATUS="not_selected"
trap 'rm -f "$COOKIE_JAR"' EXIT

sanitize_env_value() {
  local v="$1"
  v="${v//$'\r'/ }"
  v="${v//$'\n'/ }"
  printf '%s' "$v" | tr -d '\000-\010\013\014\016-\037\177'
}

load_data_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      ROOT_ADMIN_USERNAME|ROOT_ADMIN_DISPLAY_NAME|EXISTING_ADMIN_DB|ENABLE_AI|BOT_USERNAME|BOT_DISPLAY_NAME|BOT_COLOR)
        printf -v "$key" '%s' "$(sanitize_env_value "$value")"
        ;;
    esac
  done < "$file"
}

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

validate_downloaded_archive() {
  local archive_path="$1" archive_url="$2"
  if tar -tzf "$archive_path" >/dev/null 2>&1; then
    return 0
  fi

  err "Downloaded file is not a valid .tar.gz archive: $archive_url"
  err "For git mode, use: https://github.com/mcassyblasty/grishcord.git"
  err "For archive mode, use: https://github.com/mcassyblasty/grishcord/archive/refs/heads/main.tar.gz"
  if [[ "$archive_url" =~ ^https?://github\.com/[^/]+/[^/]+/?$ ]]; then
    warn "It looks like a GitHub repo page URL, not a release/archive tarball URL."
  fi
  return 1
}

extract_archive_flattened() {
  local source="$1" target="$2"
  local tmp_dir src_root
  tmp_dir="$(mktemp -d /tmp/grishcord-src.XXXXXX)"
  if [[ "$source" == *.zip ]]; then
    require_bin unzip
    unzip -oq "$source" -d "$tmp_dir"
  else
    require_bin tar
    tar -xzf "$source" -C "$tmp_dir"
  fi

  # GitHub archives wrap repo contents in a top-level directory (e.g. grishcord-main); flatten into target.
  local entries=("$tmp_dir"/*)
  if [[ ${#entries[@]} -eq 1 && -d "${entries[0]}" ]]; then
    src_root="${entries[0]}"
  else
    src_root="$tmp_dir"
  fi

  mkdir -p "$target"
  cp -a "$src_root"/. "$target"/
  rm -rf "$tmp_dir"
}

provision_repo_checkout() {
  local default_target="$PWD/grishcord"
  local target source_mode source archive_url

  warn "Grishcord repo root was not found automatically."
  target="$(prompt 'Where should Grishcord be located?' "$default_target")"
  mkdir -p "$target"

  if is_repo_dir "$target"; then
    APP_DIR="$target"
    ENV_FILE="$APP_DIR/.env"
    INSTALL_ENV_FILE="$APP_DIR/.install.env"
    return 0
  fi

  source_mode="$(prompt 'Repo source (git/wget/curl/local-archive)' 'curl')"
  case "$source_mode" in
    local-archive)
      source="$(prompt 'Path to Grishcord archive (.zip or .tar.gz)' "$PWD/grishcord.tar.gz")"
      [[ -f "$source" ]] || { err "archive file not found: $source"; exit 1; }
      extract_archive_flattened "$source" "$target"
      ;;
    git)
      require_bin git
      source="$(prompt 'Grishcord git URL' 'https://github.com/mcassyblasty/grishcord.git')"
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
    wget|curl)
      require_bin tar
      archive_url="$(prompt 'Grishcord archive URL (.tar.gz)' 'https://github.com/mcassyblasty/grishcord/archive/refs/heads/main.tar.gz')"
      source="$(mktemp /tmp/grishcord-src.XXXXXX.tar.gz)"
      if [[ "$source_mode" == "wget" ]]; then
        require_bin wget
        wget -O "$source" "$archive_url"
      else
        require_bin curl
        curl -fL --retry 3 --connect-timeout 10 -o "$source" "$archive_url"
      fi
      if ! validate_downloaded_archive "$source" "$archive_url"; then
        rm -f "$source"
        exit 1
      fi
      extract_archive_flattened "$source" "$target"
      rm -f "$source"
      ;;
    *) err "invalid repo source: $source_mode"; exit 1 ;;
  esac

  if ! is_repo_dir "$target"; then
    local nested nested_compose
    nested_compose="$(find "$target" -mindepth 1 -maxdepth 2 -type f -name docker-compose.yml | head -n1 || true)"
    nested="$(dirname "$nested_compose" 2>/dev/null || true)"
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

load_install_env(){ load_data_env_file "$INSTALL_ENV_FILE"; }

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
  local safe_value tmp_file
  safe_value="$(sanitize_env_value "$value")"
  tmp_file="$(mktemp /tmp/grishcord-env.XXXXXX)"
  awk -F= -v k="$key" -v v="$safe_value" '
    BEGIN { replaced = 0 }
    $1 == k { print k "=" v; replaced = 1; next }
    { print }
    END { if (!replaced) print k "=" v }
  ' "$ENV_FILE" > "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"

}


is_placeholder_like() {
  local raw compact
  raw="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  compact="${raw//[_-]/}"
  [[ -z "$raw" ]] && return 0
  [[ "$raw" == "change_me" || "$raw" == "change-me" || "$raw" == "changeme" || "$raw" == "replace_with_long_random_secret" || "$raw" == "replacewithlongrandomsecret" || "$raw" == "jwtsecret" || "$raw" == "yourjwtsecret" || "$raw" == "password" ]] && return 0
  [[ "$compact" == *"changeme"* || "$compact" == *"replacewith"* ]]
}

generate_secure_hex() {
  local bytes="${1:-32}"
  require_bin openssl
  openssl rand -hex "$bytes"
}

normalize_hostname() {
  local h
  h="$(sanitize_env_value "${1:-}")"
  h="${h#http://}"
  h="${h#https://}"
  h="${h%%/*}"
  h="${h%%:*}"
  printf '%s' "$h"
}

configure_env_wizard() {
  local current_site current_base current_admin current_display current_db_pass current_jwt
  local site_input site_host admin_username admin_display admin_password postgres_password db_user db_name

  current_site="$(get_env_key CADDY_SITE_ADDRESS || true)"
  current_base="$(get_env_key PUBLIC_BASE_URL || true)"
  current_admin="$(get_env_key ADMIN_USERNAME || true)"
  current_display="${ROOT_ADMIN_DISPLAY_NAME:-${current_admin:-Root Admin}}"
  current_db_pass="$(get_env_key POSTGRES_PASSWORD || true)"
  current_jwt="$(get_env_key JWT_SECRET || true)"

  if [[ -z "${current_site// }" && -n "${current_base// }" ]]; then
    current_site="$(normalize_hostname "$current_base")"
  fi

  site_input="$(prompt 'Public hostname (no scheme/path)' "${current_site:-}")"
  site_host="$(normalize_hostname "$site_input")"
  if [[ -z "${site_host// }" ]]; then
    err "Public hostname is required to configure CADDY_SITE_ADDRESS/PUBLIC_BASE_URL/CORS_ORIGINS."
    exit 1
  fi

  admin_username="$(prompt 'Admin username' "${ROOT_ADMIN_USERNAME:-${current_admin:-rootadmin}}")"
  admin_display="$(prompt 'Admin display name' "$current_display")"
  admin_password="$(prompt_secret 'Admin password')"
  [[ -n "${admin_password// }" ]] || { err "Admin password cannot be blank."; exit 1; }

  postgres_password="$(prompt_secret 'Postgres password (leave blank to keep current or auto-generate)')"
  if [[ -z "${postgres_password// }" ]]; then
    if [[ -n "${current_db_pass// }" ]] && ! is_placeholder_like "$current_db_pass"; then
      postgres_password="$current_db_pass"
      log "Keeping existing POSTGRES_PASSWORD from .env"
    else
      postgres_password="$(generate_secure_hex 32)"
      log "Generated secure POSTGRES_PASSWORD"
    fi
  fi

  if [[ -z "${current_jwt// }" ]] || is_placeholder_like "$current_jwt" || [[ ${#current_jwt} -lt 32 ]]; then
    current_jwt="$(generate_secure_hex 32)"
    log "Generated secure JWT_SECRET"
  fi

  db_user="$(get_env_key POSTGRES_USER || true)"
  db_name="$(get_env_key POSTGRES_DB || true)"
  db_user="${db_user:-grishcord}"
  db_name="${db_name:-grishcord}"

  set_env_key POSTGRES_PASSWORD "$postgres_password"
  set_env_key DATABASE_URL "postgres://${db_user}:${postgres_password}@postgres:5432/${db_name}"
  set_env_key JWT_SECRET "$current_jwt"
  set_env_key ADMIN_USERNAME "$admin_username"
  set_env_key PUBLIC_BASE_URL "https://${site_host}"
  set_env_key CORS_ORIGINS "https://${site_host}"
  set_env_key CADDY_SITE_ADDRESS "$site_host"

  ROOT_ADMIN_USERNAME="$admin_username"
  ROOT_ADMIN_DISPLAY_NAME="$admin_display"
  ROOT_ADMIN_PASSWORD="$admin_password"
}

validate_required_env() {
  local caddy_site
  caddy_site="$(get_env_key CADDY_SITE_ADDRESS || true)"
  if [[ -z "${caddy_site// }" ]]; then
    err "CADDY_SITE_ADDRESS is required in $ENV_FILE. Set it to your public hostname (no scheme/path)."
    exit 1
  fi
}

normalize_database_url() {
  local db_url rewritten
  db_url="$(get_env_key DATABASE_URL || true)"
  [[ -n "$db_url" ]] || return 0

  rewritten="$db_url"
  rewritten="${rewritten//@localhost:/@postgres:}"
  rewritten="${rewritten//@127.0.0.1:/@postgres:}"
  rewritten="${rewritten//@localhost\//@postgres/}"
  rewritten="${rewritten//@127.0.0.1\//@postgres/}"

  if [[ "$rewritten" != "$db_url" ]]; then
    warn "DATABASE_URL used localhost/127.0.0.1; rewriting host to postgres for Docker Compose networking."
    set_env_key DATABASE_URL "$rewritten"
    return 0
  fi

  if [[ "$db_url" == *"localhost"* || "$db_url" == *"127.0.0.1"* ]]; then
    err "DATABASE_URL appears to reference localhost/127.0.0.1 in an unsupported format. Please set host to postgres in $ENV_FILE."
    exit 1
  fi
}

ensure_host_bind_mount_dirs() {
  local dirs=(/mnt/grishcord/postgres /mnt/grishcord/uploads)
  local d
  for d in "${dirs[@]}"; do
    if [[ ! -d "$d" ]]; then
      mkdir -p "$d" || { err "Failed to create required bind-mount directory: $d"; exit 1; }
      log "Created bind-mount directory: $d"
    fi
    chmod 775 "$d" 2>/dev/null || warn "Could not set permissions on $d (continuing)."
    if [[ ! -w "$d" ]]; then
      warn "Directory is not writable by current user: $d (Docker may fail to write)."
    fi
  done
}

preflight_compose_sanity() {
  validate_required_env
  normalize_database_url
  ensure_host_bind_mount_dirs
}

write_install_env() {
  {
    printf 'ROOT_ADMIN_USERNAME=%s\n' "$(sanitize_env_value "$ROOT_ADMIN_USERNAME")"
    printf 'ROOT_ADMIN_DISPLAY_NAME=%s\n' "$(sanitize_env_value "$ROOT_ADMIN_DISPLAY_NAME")"
    printf 'EXISTING_ADMIN_DB=%s\n' "$(sanitize_env_value "$EXISTING_ADMIN_DB")"
    printf 'ENABLE_AI=%s\n' "$(sanitize_env_value "$ENABLE_AI")"
    printf 'BOT_USERNAME=%s\n' "$(sanitize_env_value "${BOT_USERNAME:-}")"
    printf 'BOT_DISPLAY_NAME=%s\n' "$(sanitize_env_value "${BOT_DISPLAY_NAME:-}")"
    printf 'BOT_COLOR=%s\n' "$(sanitize_env_value "${BOT_COLOR:-}")"
  } > "$INSTALL_ENV_FILE"
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

print_startup_diagnostics() {
  err "Service startup diagnostics (compose ps + recent backend/caddy logs):"
  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" ps || true
  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" logs --no-color --tail 80 backend caddy || true
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
  local status resp
  resp="$(mktemp /tmp/grish-bootstrap.XXXXXX.json)"
  status=$(curl -sS -o "$resp" -w '%{http_code}' -H 'content-type: application/json' -X POST "$base_url/api/bootstrap/root" -d "$payload" || true)

  if [[ "$status" == "200" ]]; then
    rm -f "$resp"
    log "Root admin created successfully."
    return 0
  fi

  if [[ "$status" == "409" ]]; then
    rm -f "$resp"
    log "Root admin bootstrap already initialized; continuing with login verification."
    return 0
  fi

  rm -f "$resp"
  err "root bootstrap failed (HTTP $status)"
  exit 1
}

login_admin() {
  local base_url="$1"
  local payload
  payload=$(printf '{"username":"%s","password":"%s"}' "$ROOT_ADMIN_USERNAME" "$ROOT_ADMIN_PASSWORD")
  local status resp
  resp="$(mktemp /tmp/grish-login.XXXXXX.json)"
  status=$(curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/login" -d "$payload" || true)
  rm -f "$resp"
  [[ "$status" == "200" ]] || { err "admin login failed (HTTP $status)"; exit 1; }
}

create_invite_key() {
  local base_url="$1"
  local status resp
  resp="$(mktemp /tmp/grish-invite.XXXXXX.json)"
  status=$(curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/admin/invites" -d '{}' || true)
  [[ "$status" == "200" ]] || { rm -f "$resp"; err "invite creation failed (HTTP $status)"; exit 1; }
  local invite
  invite="$(json_field inviteKey < "$resp")"
  rm -f "$resp"
  printf '%s' "$invite"
}

register_user_with_invite() {
  local base_url="$1" invite="$2" username="$3" display="$4" password="$5"
  local payload status resp
  payload=$(printf '{"inviteToken":"%s","username":"%s","displayName":"%s","password":"%s"}' "$invite" "$username" "$display" "$password")
  resp="$(mktemp /tmp/grish-register.XXXXXX.json)"
  status=$(curl -sS -o "$resp" -w '%{http_code}' -H 'content-type: application/json' -X POST "$base_url/api/register" -d "$payload" || true)
  [[ "$status" == "200" ]] || {
    if grep -q 'invalid_invite' "$resp" 2>/dev/null; then
      err "registration failed due to invalid invite"
    else
      warn "user registration returned HTTP $status"
    fi
    rm -f "$resp"
    return 1
  }
  rm -f "$resp"
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


write_aibot_env() {
  local model="${1:-}"
  if [[ -z "$model" && -f "$APP_DIR/.ollama.env" ]]; then
    model="$(awk -F= '/^OLLAMA_MODEL=/{print substr($0,index($0,"=")+1)}' "$APP_DIR/.ollama.env" | tail -n1)"
  fi
  model="${model:-gemma3:4b}"
  {
    printf 'BOT_USERNAME=%s\n' "$(sanitize_env_value "$BOT_USERNAME")"
    printf 'BOT_DISPLAY_NAME=%s\n' "$(sanitize_env_value "$BOT_DISPLAY_NAME")"
    printf 'BOT_COLOR=%s\n' "$(sanitize_env_value "$BOT_COLOR")"
    printf 'OLLAMA_MODEL=%s\n' "$(sanitize_env_value "$model")"
    printf 'BOT_CONVO_TTL_MS=900000\n'
  } > "$APP_DIR/.aibot.env"
  chmod 600 "$APP_DIR/.aibot.env" 2>/dev/null || true
  set_env_key OLLAMA_MODEL "$model"
}

configure_ai() {
  local base_url="$1"
  read -r -p "Do you want to install and enable AI (Ollama + GrishBot)? [y/N]: " ans
  ans="${ans:-N}"
  if [[ ! "$ans" =~ ^[Yy]$ ]]; then
    ENABLE_AI="false"
    AI_SETUP_STATUS="skipped"
    docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" stop bot >/dev/null 2>&1 || true
    return 0
  fi
  ENABLE_AI="true"
  AI_SETUP_STATUS="in_progress"

  log "AI setup selected: this will install/configure Ollama and set up GrishBot for Dockerized access."
  log "Configuring Ollama in docker mode so the bot can reach it via host.docker.internal:11434."
  "$APP_DIR/scripts/ollamactrl.sh" install --bind-mode docker

  BOT_USERNAME="$(prompt 'Bot username' "${BOT_USERNAME:-grishbot}")"
  BOT_DISPLAY_NAME="$(prompt 'Bot display name' "${BOT_DISPLAY_NAME:-Grish Bot}")"
  BOT_COLOR="$(prompt 'Bot color (#RRGGBB)' "${BOT_COLOR:-#7A5CFF}")"
  BOT_PASSWORD="$(prompt_secret 'Bot password')"
  [[ -n "${BOT_PASSWORD// }" ]] || { err "Bot password cannot be blank when AI is enabled."; exit 1; }

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
  write_aibot_env

  ufw_allow_docker_to_ollama

  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build bot
  if ! docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" exec -T bot sh -lc 'wget -qO- "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1 || curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null'; then
    AI_SETUP_STATUS="completed_with_ollama_warning"
    warn "Bot container cannot reach Ollama yet. Check host firewall rules for docker subnet -> tcp/11434."
  else
    AI_SETUP_STATUS="completed"
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
  configure_env_wizard

  EXISTING_ADMIN_DB="$(prompt 'Is there already an admin account in the existing DB? (y/N)' "${EXISTING_ADMIN_DB:-N}")"

  preflight_compose_sanity

  log "Starting/upgrading core compose services"
  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build --remove-orphans postgres backend frontend caddy

  local local_api_base="http://127.0.0.1"
  if ! wait_http_ok "$local_api_base/api/version" 80; then
    err "App readiness probe failed at $local_api_base/api/version"
    err "Caddy is the host-facing entrypoint; ensure caddy/backend/frontend containers are healthy."
    print_startup_diagnostics
    exit 1
  fi

  if [[ "$EXISTING_ADMIN_DB" =~ ^[Yy]$ ]]; then
    log "Skipping root bootstrap because existing DB admin was selected."
  else
    bootstrap_root_admin "$local_api_base"
  fi
  login_admin "$local_api_base"

  configure_ai "$local_api_base"

  write_install_env

  cat <<SUMMARY

Install complete.
- Backend health: OK
- Admin username: $ROOT_ADMIN_USERNAME (protected by ADMIN_USERNAME server-side checks)
- Existing admin DB mode: $EXISTING_ADMIN_DB
- AI enabled: $ENABLE_AI
- GrishBot setup status: $AI_SETUP_STATUS

Next steps:
1) Open your Grishcord URL and log in as root admin.
2) Re-run installer any time: ./install_grishcord.sh (idempotent config in .install.env).
3) Keep .env and .install.env private; they are local runtime config files.
SUMMARY
}

if [[ "${GRISHCORD_INSTALL_LIB_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
