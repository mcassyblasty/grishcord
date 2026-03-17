#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=""
ENV_FILE=""
INSTALL_ENV_FILE=""
DATA_ROOT="/mnt/grishcord"
INSTALL_MODE="fresh"
INSTALL_INTENT="normal"
DETECTED_ADMIN_USERNAME=""
DETECTED_ADMIN_USERS=()
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
      ROOT_ADMIN_USERNAME|ROOT_ADMIN_DISPLAY_NAME|EXISTING_ADMIN_DB|ENABLE_AI|BOT_USERNAME|BOT_DISPLAY_NAME|BOT_COLOR|DATA_ROOT|INSTALL_MODE|DETECTED_ADMIN_USERNAME)
        printf -v "$key" '%s' "$(sanitize_env_value "$value")"
        ;;
    esac
  done < "$file"
}

log(){ printf '[installGrishcord] %s\n' "$*"; }
warn(){ printf '[installGrishcord][warn] %s\n' "$*" >&2; }
err(){ printf '[installGrishcord][error] %s\n' "$*" >&2; }

canonical_site_host() {
  local host
  host="$(get_env_key CADDY_SITE_ADDRESS || true)"
  if [[ -z "${host// }" ]]; then
    host="$(normalize_hostname "$(get_env_key PUBLIC_BASE_URL || true)")"
  fi
  printf '%s' "$host"
}

canonical_api_curl() {
  local host
  host="$(canonical_site_host)"
  [[ -n "${host// }" ]] || {
    err "Canonical API access requires CADDY_SITE_ADDRESS or PUBLIC_BASE_URL in $ENV_FILE."
    return 1
  }
  curl --resolve "$host:443:127.0.0.1" -k "$@"
}

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

prompt_install_intent() {
  local choice normalized
  while true; do
    choice="$(prompt 'Install intent (normal/replace-source)' 'normal')"
    normalized="$(printf '%s' "$choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "$normalized" in
      ""|normal|rerun|reconfigure)
        printf 'normal'
        return 0
        ;;
      replace-source|replacesource|replace|refresh|fresh)
        printf 'replace-source'
        return 0
        ;;
    esac
    warn "Choose either normal or replace-source."
  done
}

resolve_invoking_user() {
  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    printf '%s' "$SUDO_USER"
  else
    id -un
  fi
}

resolve_invoking_group() {
  local user
  user="$(resolve_invoking_user)"
  if id -gn "$user" >/dev/null 2>&1; then
    id -gn "$user"
  else
    id -gn
  fi
}

normalize_app_repo_ownership() {
  local target="${1:-$APP_DIR}" user group
  if [[ "${EUID}" -ne 0 || -z "${SUDO_USER:-}" || "${SUDO_USER}" == "root" || -z "$target" || ! -e "$target" ]]; then
    return 0
  fi
  user="$(resolve_invoking_user)"
  group="$(resolve_invoking_group)"
  chown -R "$user:$group" "$target" 2>/dev/null || warn "Could not restore repo ownership to $user:$group under $target."
}

repair_shipped_entrypoint_permissions() {
  local target="$1"
  local path
  for path in "$target/install_grishcord.sh" "$target/scripts/"*.sh; do
    [[ -f "$path" ]] || continue
    chmod +x "$path" 2>/dev/null || true
  done
}

backup_runtime_config_files() {
  local from="$1" backup_dir="$2" rel
  for rel in .env .install.env .aibot.env .ollama.env; do
    [[ -f "$from/$rel" ]] || continue
    mkdir -p "$backup_dir/$(dirname "$rel")"
    cp -a "$from/$rel" "$backup_dir/$rel"
  done
}

restore_runtime_config_files() {
  local backup_dir="$1" target="$2" rel
  for rel in .env .install.env .aibot.env .ollama.env; do
    [[ -f "$backup_dir/$rel" ]] || continue
    mkdir -p "$target/$(dirname "$rel")"
    cp -a "$backup_dir/$rel" "$target/$rel"
  done
}

assert_safe_repo_target() {
  local target="$1"
  [[ -n "$target" && "$target" != "/" && "$target" != "." ]] || {
    err "Refusing to modify unsafe repo target: $target"
    exit 1
  }
}

assert_replace_source_target() {
  local target="$1"
  assert_safe_repo_target "$target"
  [[ -d "$target" ]] || {
    err "Replace-source requires an existing Grishcord repo at $target."
    err "Use the normal install intent if you want to create a new checkout."
    exit 1
  }
  is_repo_dir "$target" || {
    err "Replace-source can only refresh an existing Grishcord repo. Refusing to clear non-Grishcord directory: $target"
    exit 1
  }
}

clear_app_source_dir() {
  local target="$1"
  assert_safe_repo_target "$target"
  [[ -d "$target" ]] || {
    err "Refusing to clear missing app source directory: $target"
    exit 1
  }
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

run_repo_local_command() {
  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    sudo -u "$SUDO_USER" -- "$@"
  else
    "$@"
  fi
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
  local default_target="/home/grishcord/grishcord"
  local target source_mode source archive_url force_replace work_target staged_target runtime_backup

  target="${APP_DIR:-$default_target}"
  force_replace="false"
  if [[ "$INSTALL_INTENT" == "replace-source" ]]; then
    force_replace="true"
    assert_replace_source_target "$target"
  else
    mkdir -p "$target"
  fi

  if is_repo_dir "$target" && [[ "$force_replace" != "true" ]]; then
    APP_DIR="$target"
    ENV_FILE="$APP_DIR/.env"
    INSTALL_ENV_FILE="$APP_DIR/.install.env"
    return 0
  fi

  if [[ "$force_replace" == "true" ]]; then
    log "Replace-source install selected: refreshing app source at $target while preserving local runtime config."
    work_target="$(mktemp -d /tmp/grishcord-src-refresh.XXXXXX)"
  else
    warn "No Grishcord repo detected at $target; preparing source checkout."
    work_target="$target"
  fi

  source_mode="$(prompt 'Repo source (git/wget/curl/local-archive)' 'git')"
  case "$source_mode" in
    local-archive)
      source="$(prompt 'Path to Grishcord archive (.zip or .tar.gz)' "$PWD/grishcord.tar.gz")"
      [[ -f "$source" ]] || { err "archive file not found: $source"; exit 1; }
      extract_archive_flattened "$source" "$work_target"
      ;;
    git)
      require_bin git
      source="$(prompt 'Grishcord git URL' 'https://github.com/mcassyblasty/grishcord.git')"
      if [[ "$force_replace" == "true" ]]; then
        git clone --depth 1 "$source" "$work_target"
      elif [[ -d "$target/.git" ]]; then
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
      extract_archive_flattened "$source" "$work_target"
      rm -f "$source"
      ;;
    *) err "invalid repo source: $source_mode"; exit 1 ;;
  esac

  staged_target="$work_target"
  if ! is_repo_dir "$staged_target"; then
    local nested nested_compose
    nested_compose="$(find "$staged_target" -mindepth 1 -maxdepth 2 -type f -name docker-compose.yml | head -n1 || true)"
    nested="$(dirname "$nested_compose" 2>/dev/null || true)"
    if [[ -n "$nested" ]] && is_repo_dir "$nested"; then
      staged_target="$nested"
    fi
  fi

  is_repo_dir "$staged_target" || { err "Could not prepare a valid Grishcord repo at $target"; exit 1; }

  if [[ "$force_replace" == "true" ]]; then
    runtime_backup="$(mktemp -d /tmp/grishcord-runtime.XXXXXX)"
    backup_runtime_config_files "$target" "$runtime_backup"
    clear_app_source_dir "$target"
    cp -a "$staged_target"/. "$target"/
    restore_runtime_config_files "$runtime_backup" "$target"
    rm -rf "$runtime_backup" "$work_target"
    staged_target="$target"
  fi

  repair_shipped_entrypoint_permissions "$staged_target"
  normalize_app_repo_ownership "$staged_target"

  APP_DIR="$staged_target"
  ENV_FILE="$APP_DIR/.env"
  INSTALL_ENV_FILE="$APP_DIR/.install.env"
}

resolve_app_dir() {
  local script_dir pwd_dir home_dir candidate default_target
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  pwd_dir="$(pwd)"
  home_dir="${HOME:-}/grishcord"
  default_target="/home/grishcord/grishcord"

  APP_DIR="$default_target"
  for candidate in "$script_dir" "$pwd_dir" "$home_dir" "$default_target"; do
    [[ -n "$candidate" ]] || continue
    if is_repo_dir "$candidate"; then
      APP_DIR="$candidate"
      break
    fi
  done

  ENV_FILE="$APP_DIR/.env"
  INSTALL_ENV_FILE="$APP_DIR/.install.env"
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

get_file_env_key() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$1==k {print substr($0,index($0,"=")+1)}' "$file" | tail -n 1
}

encode_uri_component() {
  local raw="${1:-}" out="" ch hex i
  for ((i=0; i<${#raw}; i+=1)); do
    ch="${raw:i:1}"
    case "$ch" in
      [a-zA-Z0-9.~_-]) out+="$ch" ;;
      *)
        printf -v hex '%%%02X' "'$ch"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

build_database_url() {
  local db_user="$1" db_password="$2" db_name="$3"
  printf 'postgres://%s:%s@postgres:5432/%s' \
    "$(encode_uri_component "$db_user")" \
    "$(encode_uri_component "$db_password")" \
    "$(encode_uri_component "$db_name")"
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

inspect_postgres_data_dir() {
  local dir="$DATA_ROOT/postgres" entries err_file

  if [[ ! -e "$dir" ]]; then
    printf 'missing'
    return 0
  fi

  if [[ ! -d "$dir" ]]; then
    printf 'invalid'
    return 0
  fi

  if [[ ! -r "$dir" || ! -x "$dir" ]]; then
    printf 'unreadable'
    return 0
  fi

  err_file="$(mktemp /tmp/grishcord-data-root-inspect.XXXXXX)"
  entries="$(find "$dir" -mindepth 1 -maxdepth 1 -print 2>"$err_file" || true)"
  if [[ -s "$err_file" ]]; then
    if grep -qi 'permission denied' "$err_file"; then
      rm -f "$err_file"
      printf 'unreadable'
      return 0
    fi
    rm -f "$err_file"
    printf 'error'
    return 0
  fi
  rm -f "$err_file"

  if [[ -z "${entries//[[:space:]]/}" ]]; then
    printf 'empty'
  else
    printf 'populated'
  fi
}

current_postgres_user() {
  local db_user
  db_user="$(get_env_key POSTGRES_USER || true)"
  printf '%s' "${db_user:-grishcord}"
}

current_postgres_db() {
  local db_name
  db_name="$(get_env_key POSTGRES_DB || true)"
  printf '%s' "${db_name:-grishcord}"
}

run_existing_db_query_authenticated() {
  local sql="$1"
  local db_user db_name db_pass
  db_user="$(current_postgres_user)"
  db_name="$(current_postgres_db)"
  db_pass="$(get_env_key POSTGRES_PASSWORD || true)"

  [[ -n "${db_pass// }" ]] || {
    err "POSTGRES_PASSWORD is required in $ENV_FILE before existing DB validation can run."
    return 1
  }

  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" exec -T \
    -e PGPASSWORD="$db_pass" \
    postgres \
    psql -v ON_ERROR_STOP=1 -w -h 127.0.0.1 -U "$db_user" -d "$db_name" -Atc "$sql"
}

ensure_existing_db_credentials() {
  local db_user db_name current_db_pass
  db_user="$(current_postgres_user)"
  db_name="$(current_postgres_db)"

  current_db_pass="$(get_env_key POSTGRES_PASSWORD || true)"
  if [[ -z "${current_db_pass// }" ]] || is_placeholder_like "$current_db_pass"; then
    current_db_pass="$(prompt_secret 'Existing Postgres password (required for existing DB)')"
    [[ -n "${current_db_pass// }" ]] || { err "Existing Postgres password is required for existing DB verification."; exit 1; }
  fi

  set_env_key POSTGRES_PASSWORD "$current_db_pass"
  set_env_key DATABASE_URL "$(build_database_url "$db_user" "$current_db_pass" "$db_name")"
}

configure_env_wizard() {
  local current_site current_base current_admin current_display current_db_pass current_jwt current_bootstrap
  local site_input site_host postgres_password db_user db_name

  current_site="$(get_env_key CADDY_SITE_ADDRESS || true)"
  current_base="$(get_env_key PUBLIC_BASE_URL || true)"
  current_admin="$(get_env_key ADMIN_USERNAME || true)"
  current_display="${ROOT_ADMIN_DISPLAY_NAME:-${current_admin:-Root Admin}}"
  current_db_pass="$(get_env_key POSTGRES_PASSWORD || true)"
  current_jwt="$(get_env_key JWT_SECRET || true)"
  current_bootstrap="$(get_env_key BOOTSTRAP_ROOT_TOKEN || true)"

  if [[ -z "${current_site// }" && -n "${current_base// }" ]]; then
    current_site="$(normalize_hostname "$current_base")"
  fi

  site_input="$(prompt 'Public hostname (no scheme/path)' "${current_site:-}")"
  site_host="$(normalize_hostname "$site_input")"
  if [[ -z "${site_host// }" ]]; then
    err "Public hostname is required to configure CADDY_SITE_ADDRESS/PUBLIC_BASE_URL/CORS_ORIGINS."
    exit 1
  fi

  if [[ "$INSTALL_MODE" == "existing" ]]; then
    if [[ -n "${current_db_pass// }" ]] && ! is_placeholder_like "$current_db_pass"; then
      postgres_password="$current_db_pass"
      log "Keeping existing POSTGRES_PASSWORD from .env"
    elif [[ "$(inspect_postgres_data_dir)" == "populated" ]]; then
      err "Existing DB files were detected under $DATA_ROOT/postgres but POSTGRES_PASSWORD is missing/placeholder."
      err "Provide the existing Postgres password so the installer can safely reuse the DB."
      exit 1
    else
      err "Existing DB install requires a valid POSTGRES_PASSWORD in $ENV_FILE."
      exit 1
    fi
  else
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
  fi

  if [[ "$INSTALL_MODE" == "existing" ]]; then
    if [[ -z "${current_jwt// }" ]]; then
      err "Existing DB detected but JWT_SECRET is empty in $ENV_FILE. Refusing to rotate auth secrets automatically."
      exit 1
    fi
    if [[ -z "${current_bootstrap// }" ]]; then
      current_bootstrap="$(generate_secure_hex 32)"
      log "Generated BOOTSTRAP_ROOT_TOKEN"
    fi
  else
    if [[ -z "${current_jwt// }" ]] || is_placeholder_like "$current_jwt" || [[ ${#current_jwt} -lt 32 ]]; then
      current_jwt="$(generate_secure_hex 32)"
      log "Generated secure JWT_SECRET"
    fi

    if [[ -z "${current_bootstrap// }" ]] || is_placeholder_like "$current_bootstrap" || [[ ${#current_bootstrap} -lt 32 ]]; then
      current_bootstrap="$(generate_secure_hex 32)"
      log "Generated secure BOOTSTRAP_ROOT_TOKEN"
    fi
  fi

  db_user="$(get_env_key POSTGRES_USER || true)"
  db_name="$(get_env_key POSTGRES_DB || true)"
  db_user="${db_user:-grishcord}"
  db_name="${db_name:-grishcord}"

  set_env_key POSTGRES_PASSWORD "$postgres_password"
  set_env_key DATABASE_URL "$(build_database_url "$db_user" "$postgres_password" "$db_name")"
  set_env_key JWT_SECRET "$current_jwt"
  set_env_key BOOTSTRAP_ROOT_TOKEN "$current_bootstrap"
  set_env_key PUBLIC_BASE_URL "https://${site_host}"
  set_env_key CORS_ORIGINS "https://${site_host}"
  set_env_key CADDY_SITE_ADDRESS "$site_host"
  set_env_key COOKIE_SECURE "true"
  set_env_key HOST_DATA_ROOT "$DATA_ROOT"
}

validate_required_env() {
  local caddy_site public_base cookie_secure public_host
  caddy_site="$(get_env_key CADDY_SITE_ADDRESS || true)"
  public_base="$(get_env_key PUBLIC_BASE_URL || true)"
  cookie_secure="$(get_env_key COOKIE_SECURE || true)"
  if [[ -z "${caddy_site// }" ]]; then
    err "CADDY_SITE_ADDRESS is required in $ENV_FILE. Set it to your public hostname (no scheme/path)."
    exit 1
  fi
  if [[ "$public_base" != https://* ]]; then
    err "PUBLIC_BASE_URL must be set to your canonical HTTPS origin in $ENV_FILE."
    exit 1
  fi
  public_host="$(normalize_hostname "$public_base")"
  if [[ "$public_host" != "$caddy_site" ]]; then
    err "PUBLIC_BASE_URL host must match CADDY_SITE_ADDRESS exactly."
    exit 1
  fi
  if [[ "$cookie_secure" != "true" ]]; then
    err "COOKIE_SECURE=true is required for internet-facing deployments."
    exit 1
  fi
}

validate_proxy_lockdown() {
  local caddyfile="$APP_DIR/caddy/Caddyfile"
  [[ -f "$caddyfile" ]] || { err "Missing $caddyfile"; exit 1; }
  if ! grep -Eq '^[[:space:]]*http://\{\$CADDY_SITE_ADDRESS(:[^}]*)?\}[[:space:]]*\{' "$caddyfile"; then
    err "caddy/Caddyfile must include a canonical HTTP redirect site for CADDY_SITE_ADDRESS."
    exit 1
  fi
  if ! grep -Eq '^[[:space:]]*https://\{\$CADDY_SITE_ADDRESS(:[^}]*)?\}[[:space:]]*\{' "$caddyfile"; then
    err "caddy/Caddyfile must include a canonical HTTPS site for CADDY_SITE_ADDRESS."
    exit 1
  fi
  if grep -Eq '^[[:space:]]*:443[[:space:]]*\{' "$caddyfile"; then
    err "caddy/Caddyfile still exposes a catch-all :443 site. Remove it before deployment."
    exit 1
  fi
  if ! grep -Eq '^[[:space:]]*:80[[:space:]]*\{' "$caddyfile" || ! grep -Eq '^[[:space:]]*respond[[:space:]].*[[:space:]]421([[:space:]]|$)' "$caddyfile"; then
    err "caddy/Caddyfile must reject non-canonical HTTP hosts with 421."
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
  local dirs=("$DATA_ROOT/postgres" "$DATA_ROOT/uploads")
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
  validate_proxy_lockdown
  normalize_database_url
  ensure_host_bind_mount_dirs
}

write_install_env() {
  {
    printf 'ROOT_ADMIN_USERNAME=%s\n' "$(sanitize_env_value "$ROOT_ADMIN_USERNAME")"
    printf 'ROOT_ADMIN_DISPLAY_NAME=%s\n' "$(sanitize_env_value "$ROOT_ADMIN_DISPLAY_NAME")"
    printf 'EXISTING_ADMIN_DB=%s\n' "$(sanitize_env_value "$EXISTING_ADMIN_DB")"
    printf 'INSTALL_MODE=%s\n' "$(sanitize_env_value "$INSTALL_MODE")"
    printf 'DETECTED_ADMIN_USERNAME=%s\n' "$(sanitize_env_value "$DETECTED_ADMIN_USERNAME")"
    printf 'DATA_ROOT=%s\n' "$(sanitize_env_value "$DATA_ROOT")"
    printf 'ENABLE_AI=%s\n' "$(sanitize_env_value "$ENABLE_AI")"
    printf 'BOT_USERNAME=%s\n' "$(sanitize_env_value "${BOT_USERNAME:-}")"
    printf 'BOT_DISPLAY_NAME=%s\n' "$(sanitize_env_value "${BOT_DISPLAY_NAME:-}")"
    printf 'BOT_COLOR=%s\n' "$(sanitize_env_value "${BOT_COLOR:-}")"
  } > "$INSTALL_ENV_FILE"
  chmod 600 "$INSTALL_ENV_FILE" 2>/dev/null || true
}

wait_http_ok() {
  local url="$1"; local tries="${2:-60}"
  shift 2
  local extra=("$@")
  local i
  for ((i=1; i<=tries; i+=1)); do
    if curl -fsS "${extra[@]}" "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

wait_postgres_ready() {
  local tries="${1:-60}" i
  for ((i=1; i<=tries; i+=1)); do
    if docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_existing_db_credentials() {
  local err_out err_file
  err_file="$(mktemp /tmp/grishcord-db-auth.XXXXXX)"
  if ! run_existing_db_query_authenticated 'SELECT 1;' >/dev/null 2>"$err_file"; then
    err_out="$(cat "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    err "Existing Postgres credentials did not authenticate over TCP to the running DB."
    [[ -n "${err_out// }" ]] && err "Details: $err_out"
    err "Re-enter the existing Postgres password or reset the DB role password to match POSTGRES_PASSWORD in $ENV_FILE."
    exit 1
  fi
  rm -f "$err_file"
}

list_existing_admins_from_db() {
  local sql out_file configured_admin err_file
  configured_admin="$(sanitize_env_value "$(get_env_key ADMIN_USERNAME || true)")"
  sql="WITH root_state AS (SELECT EXISTS (SELECT 1 FROM users WHERE is_root_admin = true) AS has_root) SELECT username FROM users, root_state WHERE disabled=false AND (is_root_admin=true OR (root_state.has_root=false AND username='${configured_admin}')) ORDER BY is_root_admin DESC, username ASC;"
  out_file="$(mktemp /tmp/grish-admin-users.XXXXXX)"
  err_file="$(mktemp /tmp/grishcord-db-detect.XXXXXX)"
  if ! run_existing_db_query_authenticated "$sql" >"$out_file" 2>"$err_file"; then
    local err_out
    err_out="$(cat "$err_file" 2>/dev/null || true)"
    rm -f "$out_file" "$err_file"
    err "Failed to inspect existing DB in $DATA_ROOT/postgres."
    err "Details: $err_out"
    err "Check DB path integrity and Postgres credentials in $ENV_FILE."
    exit 1
  fi
  rm -f "$err_file"
  mapfile -t DETECTED_ADMIN_USERS <"$out_file"
  rm -f "$out_file"
}

detect_existing_admin_from_db() {
  local count_sql users_count err_file

  count_sql='SELECT COUNT(*)::bigint FROM users;'
  err_file="$(mktemp /tmp/grishcord-db-detect.XXXXXX)"
  users_count="$(run_existing_db_query_authenticated "$count_sql" 2>"$err_file" || true)"
  if [[ -s "$err_file" ]]; then
    local err_out
    err_out="$(cat "$err_file")"
    rm -f "$err_file"
    err "Failed to inspect existing DB in $DATA_ROOT/postgres."
    err "Details: $err_out"
    err "Check DB path integrity and Postgres credentials in $ENV_FILE."
    exit 1
  fi
  rm -f "$err_file"

  users_count="${users_count//[[:space:]]/}"
  if [[ -z "$users_count" || "$users_count" == "0" ]]; then
    INSTALL_MODE="fresh"
    DETECTED_ADMIN_USERNAME=""
    DETECTED_ADMIN_USERS=()
    return 0
  fi

  list_existing_admins_from_db
  if [[ ${#DETECTED_ADMIN_USERS[@]} -eq 0 ]]; then
    err "Existing DB contains users but no root owner account or ADMIN_USERNAME backfill candidate was found."
    err "Refusing to continue automatically to avoid damaging existing auth state."
    exit 1
  fi

  INSTALL_MODE="existing"
  DETECTED_ADMIN_USERNAME="${DETECTED_ADMIN_USERS[0]}"
}

prompt_fresh_admin_setup() {
  local current_admin current_display
  current_admin="$(get_env_key ADMIN_USERNAME || true)"
  current_display="${ROOT_ADMIN_DISPLAY_NAME:-${current_admin:-Root Admin}}"
  ROOT_ADMIN_USERNAME="$(prompt 'Admin username' "${ROOT_ADMIN_USERNAME:-${current_admin:-rootadmin}}")"
  ROOT_ADMIN_DISPLAY_NAME="$(prompt 'Admin display name' "$current_display")"
  ROOT_ADMIN_PASSWORD="$(prompt_secret 'Admin password')"
  [[ -n "${ROOT_ADMIN_PASSWORD// }" ]] || { err "Admin password cannot be blank."; exit 1; }
  set_env_key ADMIN_USERNAME "$ROOT_ADMIN_USERNAME"
}

select_existing_admin_username() {
  if [[ ${#DETECTED_ADMIN_USERS[@]} -le 1 ]]; then
    DETECTED_ADMIN_USERNAME="${DETECTED_ADMIN_USERS[0]}"
    return 0
  fi

  log "Multiple root owner candidates were detected in the existing DB."
  local i choice
  for ((i=0; i<${#DETECTED_ADMIN_USERS[@]}; i+=1)); do
    printf '  %d) %s\n' "$((i+1))" "${DETECTED_ADMIN_USERS[$i]}"
  done

  while true; do
    choice="$(prompt 'Select admin account number for verification' '1')"
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#DETECTED_ADMIN_USERS[@]} )); then
      DETECTED_ADMIN_USERNAME="${DETECTED_ADMIN_USERS[$((choice-1))]}"
      return 0
    fi
    warn "Invalid selection. Enter a number between 1 and ${#DETECTED_ADMIN_USERS[@]}."
  done
}

verify_admin_password_with_db() {
  local username="$1" password="$2"
  local rc out_file err_file
  out_file="$(mktemp /tmp/grish-admin-verify.out.XXXXXX)"
  err_file="$(mktemp /tmp/grish-admin-verify.err.XXXXXX)"
  if docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" run --rm --no-deps -T \
    -e VERIFY_USERNAME="$username" \
    -e VERIFY_PASSWORD="$password" \
    backend node -e "const { Client } = require('pg'); const bcrypt = require('bcryptjs'); (async () => { const client = new Client({ connectionString: process.env.DATABASE_URL }); try { await client.connect(); const r = await client.query('SELECT password_hash, disabled FROM users WHERE username = \$1 LIMIT 1', [process.env.VERIFY_USERNAME]); const row = r.rows[0]; if (!row || row.disabled) { process.exit(2); } const ok = await bcrypt.compare(process.env.VERIFY_PASSWORD || '', row.password_hash || ''); process.exit(ok ? 0 : 3); } catch (e) { console.error(e && e.message ? e.message : String(e)); process.exit(4); } finally { await client.end().catch(() => {}); } })();" \
    >"$out_file" 2>"$err_file"; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0) rm -f "$out_file" "$err_file"; return 0 ;;
    3) rm -f "$out_file" "$err_file"; return 1 ;;
    2)
      warn "Selected admin account no longer eligible for verification. Re-detecting admins."
      rm -f "$out_file" "$err_file"
      return 2
      ;;
    *)
      local detail
      detail="$(cat "$err_file" 2>/dev/null || true)"
      rm -f "$out_file" "$err_file"
      err "Failed to verify existing admin password against DB state."
      [[ -n "${detail// }" ]] && err "Details: $detail"
      return 4
      ;;
  esac
}

prompt_existing_admin_password() {
  local attempts ans verify_rc
  select_existing_admin_username
  ROOT_ADMIN_USERNAME="$DETECTED_ADMIN_USERNAME"
  ROOT_ADMIN_DISPLAY_NAME="$DETECTED_ADMIN_USERNAME"
  attempts=0
  while true; do
    attempts=$((attempts+1))
    ROOT_ADMIN_PASSWORD="$(prompt_secret "Existing admin password for $ROOT_ADMIN_USERNAME")"
    [[ -n "${ROOT_ADMIN_PASSWORD// }" ]] || { warn "Password cannot be blank."; continue; }

    if verify_admin_password_with_db "$ROOT_ADMIN_USERNAME" "$ROOT_ADMIN_PASSWORD"; then
      log "Existing admin credentials verified."
      return 0
    fi
    verify_rc=$?

    if [[ "$verify_rc" == "2" ]]; then
      detect_existing_admin_from_db
      select_existing_admin_username
      ROOT_ADMIN_USERNAME="$DETECTED_ADMIN_USERNAME"
      ROOT_ADMIN_DISPLAY_NAME="$DETECTED_ADMIN_USERNAME"
      continue
    fi
    if [[ "$verify_rc" == "4" ]]; then
      err "Cannot continue without successful admin verification."
      exit 1
    fi

    warn "Admin password verification failed."
    read -r -p "Try again? [Y/n]: " ans
    ans="${ans:-Y}"
    if [[ ! "$ans" =~ ^[Yy]$ ]]; then
      err "Aborted by operator after failed admin password verification."
      exit 1
    fi
    [[ $attempts -lt 20 ]] || { err "Too many failed password attempts."; exit 1; }
  done
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

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\f'/\\f}"
  value="${value//$'\b'/\\b}"
  printf '%s' "$value"
}

json_string() {
  printf '"%s"' "$(json_escape "$1")"
}

clear_cookie_jar() {
  : > "$COOKIE_JAR"
}

user_exists_in_db() {
  local username="$1"
  local query escaped_username result
  escaped_username="${username//\'/\'\'}"
  query="SELECT 1 FROM users WHERE username = '$escaped_username' LIMIT 1;"
  result="$(run_existing_db_query_authenticated "$query" 2>/dev/null || true)"
  [[ "${result//[[:space:]]/}" == "1" ]]
}

bootstrap_root_admin() {
  local base_url="$1"
  log "Bootstrapping root admin account"

  local payload
  payload=$(printf '{"username":%s,"displayName":%s,"password":%s}' \
    "$(json_string "$ROOT_ADMIN_USERNAME")" \
    "$(json_string "$ROOT_ADMIN_DISPLAY_NAME")" \
    "$(json_string "$ROOT_ADMIN_PASSWORD")")
  local status resp
  resp="$(mktemp /tmp/grish-bootstrap.XXXXXX.json)"
  local bootstrap_token
  bootstrap_token="$(get_env_key BOOTSTRAP_ROOT_TOKEN || true)"
  if [[ -z "${bootstrap_token// }" ]]; then
    err "BOOTSTRAP_ROOT_TOKEN is required for initial root bootstrap."
    exit 1
  fi

  status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -H 'content-type: application/json' -H "x-bootstrap-token: $bootstrap_token" -X POST "$base_url/api/bootstrap/root" -d "$payload" || true)

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
  payload=$(printf '{"username":%s,"password":%s}' \
    "$(json_string "$ROOT_ADMIN_USERNAME")" \
    "$(json_string "$ROOT_ADMIN_PASSWORD")")
  local status resp
  resp="$(mktemp /tmp/grish-login.XXXXXX.json)"
  status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/login" -d "$payload" || true)
  rm -f "$resp"
  [[ "$status" == "200" ]] || { err "admin login failed (HTTP $status)"; exit 1; }
}

create_invite_key() {
  local base_url="$1"
  local status resp
  resp="$(mktemp /tmp/grish-invite.XXXXXX.json)"
  status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/admin/invites" -d '{}' || true)
  [[ "$status" == "200" ]] || { rm -f "$resp"; err "invite creation failed (HTTP $status)"; exit 1; }
  local invite
  invite="$(json_field inviteKey < "$resp")"
  rm -f "$resp"
  printf '%s' "$invite"
}

register_user_with_invite() {
  local base_url="$1" invite="$2" username="$3" display="$4" password="$5"
  local payload status resp
  payload=$(printf '{"inviteToken":%s,"username":%s,"displayName":%s,"password":%s}' \
    "$(json_string "$invite")" \
    "$(json_string "$username")" \
    "$(json_string "$display")" \
    "$(json_string "$password")")
  resp="$(mktemp /tmp/grish-register.XXXXXX.json)"
  status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -H 'content-type: application/json' -X POST "$base_url/api/register" -d "$payload" || true)
  [[ "$status" == "200" ]] || {
    if grep -q 'invalid_invite' "$resp" 2>/dev/null; then
      err "registration failed due to invalid invite"
    elif user_exists_in_db "$username"; then
      log "Bot account already exists in the DB; reusing the existing account."
      rm -f "$resp"
      return 2
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
  local login_payload profile_payload login_status profile_status resp detail
  clear_cookie_jar
  login_payload=$(printf '{"username":%s,"password":%s}' \
    "$(json_string "$username")" \
    "$(json_string "$password")")
  profile_payload=$(printf '{"displayName":%s,"displayColor":%s}' \
    "$(json_string "$display")" \
    "$(json_string "$color")")

  resp="$(mktemp /tmp/grish-bot-login.XXXXXX.json)"
  login_status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "$base_url/api/login" -d "$login_payload" || true)
  if [[ "$login_status" != "200" ]]; then
    detail="$(cat "$resp" 2>/dev/null || true)"
    rm -f "$resp"
    err "Bot login failed for $username (HTTP $login_status)."
    if [[ "$login_status" == "401" ]]; then
      err "The provided bot password was not accepted for the existing account."
    fi
    [[ -n "${detail// }" ]] && err "Details: $detail"
    exit 1
  fi
  rm -f "$resp"

  resp="$(mktemp /tmp/grish-bot-profile.XXXXXX.json)"
  profile_status=$(canonical_api_curl -sS -o "$resp" -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" -H 'content-type: application/json' -X PATCH "$base_url/api/me/profile" -d "$profile_payload" || true)
  if [[ "$profile_status" != "200" ]]; then
    detail="$(cat "$resp" 2>/dev/null || true)"
    warn "Bot profile update returned HTTP $profile_status; continuing."
    [[ -n "${detail// }" ]] && warn "Profile update details: $detail"
  fi
  rm -f "$resp"
}

legacy_ufw_allow_docker_to_ollama_unused() { return 0; }


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
  } > "$APP_DIR/.aibot.env"
  chmod 600 "$APP_DIR/.aibot.env" 2>/dev/null || true
  set_env_key OLLAMA_MODEL "$model"
}

get_ollama_base_url() {
  local base_url
  base_url="$(get_file_env_key "$APP_DIR/.ollama.env" OLLAMA_BASE_URL || true)"
  if [[ -z "${base_url// }" ]]; then
    base_url="$(get_env_key OLLAMA_BASE_URL || true)"
  fi
  printf '%s' "$(sanitize_env_value "$base_url")"
}

configure_ai() {
  local base_url="$1"
  local ollama_base_url invite_key default_models_path
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

  log "AI setup selected: this will install/configure Ollama and set up GrishBot on the single secure local AI path."
  default_models_path="${DATA_ROOT%/}/models"
  repair_shipped_entrypoint_permissions "$APP_DIR"
  normalize_app_repo_ownership "$APP_DIR"
  run_repo_local_command env "AIBOT_DEFAULT_MODELS_PATH=$default_models_path" bash "$APP_DIR/scripts/aibotctl.sh" ollama install

  BOT_USERNAME="$(prompt 'Bot username' "${BOT_USERNAME:-Grishbot}")"
  BOT_DISPLAY_NAME="$(prompt 'Bot display name' "${BOT_DISPLAY_NAME:-Grishbot}")"
  BOT_COLOR="$(prompt 'Bot color (#RRGGBB)' "${BOT_COLOR:-#7A5CFF}")"
  BOT_PASSWORD="$(prompt_secret 'Bot password')"
  [[ -n "${BOT_PASSWORD// }" ]] || { err "Bot password cannot be blank when AI is enabled."; exit 1; }
  set_env_key BOT_USERNAME "$BOT_USERNAME"
  set_env_key BOT_PASSWORD "$BOT_PASSWORD"
  set_env_key BOT_DISPLAY_NAME "$BOT_DISPLAY_NAME"
  set_env_key BOT_COLOR "$BOT_COLOR"
  write_aibot_env
  normalize_app_repo_ownership "$APP_DIR"

  login_admin "$base_url"
  invite_key="$(create_invite_key "$base_url")"
  local register_rc=0
  register_user_with_invite "$base_url" "$invite_key" "$BOT_USERNAME" "$BOT_DISPLAY_NAME" "$BOT_PASSWORD" || register_rc=$?
  if [[ "$register_rc" != "0" && "$register_rc" != "2" ]]; then
    warn "Bot user may already exist; continuing with profile update/login checks."
  fi

  ensure_user_profile "$base_url" "$BOT_USERNAME" "$BOT_PASSWORD" "$BOT_DISPLAY_NAME" "$BOT_COLOR"

  ollama_base_url="$(get_ollama_base_url)"
  if [[ -z "${ollama_base_url// }" ]]; then
    AI_SETUP_STATUS="failed"
    err "AI setup did not produce OLLAMA_BASE_URL in $APP_DIR/.ollama.env."
    err "Re-run $APP_DIR/scripts/aibotctl.sh ollama install after fixing Docker bridge access."
    exit 1
  fi
  if [[ "$ollama_base_url" != http://* && "$ollama_base_url" != https://* ]]; then
    AI_SETUP_STATUS="failed"
    err "Resolved OLLAMA_BASE_URL is invalid: $ollama_base_url"
    exit 1
  fi
  set_env_key OLLAMA_BASE_URL "$ollama_base_url"

  docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build bot
  if ! docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" exec -T -e VERIFY_OLLAMA_URL="$ollama_base_url" bot sh -lc 'wget -qO- "$VERIFY_OLLAMA_URL/api/tags" >/dev/null 2>&1 || curl -fsS "$VERIFY_OLLAMA_URL/api/tags" >/dev/null'; then
    AI_SETUP_STATUS="failed"
    err "Bot container cannot reach secure Ollama endpoint: $ollama_base_url"
    err "Fix the Ollama secure endpoint configuration before continuing."
    exit 1
  fi
  AI_SETUP_STATUS="completed"
  log "Bot container connectivity to Ollama verified at $ollama_base_url."
}

main() {
  require_bin docker
  require_bin curl
  resolve_app_dir
  INSTALL_INTENT="$(prompt_install_intent)"
  APP_DIR="$(prompt 'Where should Grishcord be located?' "$APP_DIR")"
  ENV_FILE="$APP_DIR/.env"
  INSTALL_ENV_FILE="$APP_DIR/.install.env"

  load_install_env
  DATA_ROOT="$(prompt 'Where should Grishcord DB be located?' "${DATA_ROOT:-/mnt/grishcord/}")"
  DATA_ROOT="${DATA_ROOT%/}"
  [[ -n "${DATA_ROOT// }" ]] || { err "DB location cannot be empty."; exit 1; }

  provision_repo_checkout
  ENV_FILE="$APP_DIR/.env"
  INSTALL_ENV_FILE="$APP_DIR/.install.env"
  log "Using repo directory: $APP_DIR"

  ensure_env_file
  set_env_key HOST_DATA_ROOT "$DATA_ROOT"
  normalize_app_repo_ownership "$APP_DIR"

  local db_dir_state
  db_dir_state="$(inspect_postgres_data_dir)"

  case "$db_dir_state" in
    populated)
      INSTALL_MODE="existing"
      EXISTING_ADMIN_DB="Y"
      ensure_existing_db_credentials

      log "Existing DB files detected under $DATA_ROOT/postgres; validating existing install state."
      docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d postgres
      if ! wait_postgres_ready 60; then
        err "Postgres did not become ready while checking existing DB state."
        exit 1
      fi
      verify_existing_db_credentials
      detect_existing_admin_from_db

      if [[ "$INSTALL_MODE" == "existing" ]]; then
        ROOT_ADMIN_USERNAME="$DETECTED_ADMIN_USERNAME"
        ROOT_ADMIN_DISPLAY_NAME="$DETECTED_ADMIN_USERNAME"
        set_env_key ADMIN_USERNAME "$ROOT_ADMIN_USERNAME"
        log "Detected existing admin account: $ROOT_ADMIN_USERNAME"
        prompt_existing_admin_password
      fi
      ;;
    missing|empty)
      ;;
    unreadable)
      err "Cannot determine install mode: $DATA_ROOT/postgres exists but is not readable by current user."
      err "Refusing to assume fresh install. Fix permissions or run installer with sufficient privileges."
      exit 1
      ;;
    invalid)
      err "Cannot determine install mode: $DATA_ROOT/postgres exists but is not a directory."
      exit 1
      ;;
    error|*)
      err "Failed to inspect $DATA_ROOT/postgres. Refusing to continue to avoid misclassifying an existing install."
      exit 1
      ;;
  esac

  if [[ "$INSTALL_MODE" != "existing" ]]; then
    INSTALL_MODE="fresh"
    EXISTING_ADMIN_DB="N"
    prompt_fresh_admin_setup
  fi

  configure_env_wizard
  normalize_app_repo_ownership "$APP_DIR"
  preflight_compose_sanity

  log "Starting/upgrading core compose services"
  if ! docker compose --project-directory "$APP_DIR" --env-file "$ENV_FILE" up -d --build --remove-orphans postgres backend frontend caddy; then
    err "Core compose services failed to start cleanly."
    print_startup_diagnostics
    exit 1
  fi

  local local_api_host local_api_base
  local_api_host="$(canonical_site_host)"
  [[ -n "${local_api_host// }" ]] || { err "CADDY_SITE_ADDRESS is required before startup probes."; exit 1; }
  local_api_base="https://$local_api_host"
  if ! wait_http_ok "$local_api_base/api/version" 80 "--resolve" "$local_api_host:443:127.0.0.1" "-k"; then
    err "App readiness probe failed at $local_api_base/api/version"
    err "Caddy is the host-facing entrypoint; ensure caddy/backend/frontend containers are healthy."
    print_startup_diagnostics
    exit 1
  fi

  if [[ "$INSTALL_MODE" == "existing" ]]; then
    log "Skipping root bootstrap because existing DB admin was auto-detected and verified."
  else
    bootstrap_root_admin "$local_api_base"
    login_admin "$local_api_base"
  fi

  configure_ai "$local_api_base"

  write_install_env
  normalize_app_repo_ownership "$APP_DIR"

  cat <<SUMMARY

Install complete.
- Backend health: OK
- Root owner username: $ROOT_ADMIN_USERNAME
- Install mode: $INSTALL_MODE
- Existing admin DB mode: $EXISTING_ADMIN_DB
- Data root: $DATA_ROOT
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
