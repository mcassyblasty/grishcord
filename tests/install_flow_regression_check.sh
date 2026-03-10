#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/grishcord-install-flow.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

export GRISHCORD_INSTALL_LIB_ONLY=1
# shellcheck disable=SC1091
source "$ROOT_DIR/install_grishcord.sh"

APP_DIR="$ROOT_DIR"
ENV_FILE="$TMP_DIR/.env"
INSTALL_ENV_FILE="$TMP_DIR/.install.env"
DATA_ROOT="$TMP_DIR/data"
mkdir -p "$DATA_ROOT/postgres"
: > "$ENV_FILE"

set_env_key POSTGRES_USER grishcord
set_env_key POSTGRES_DB grishcord
set_env_key ADMIN_USERNAME rootadmin
set_env_key JWT_SECRET existing_jwt_secret_which_is_long_enough_123456
set_env_key BOOTSTRAP_ROOT_TOKEN bootstrap_token_value_which_is_long_enough
set_env_key POSTGRES_PASSWORD existing_db_password
set_env_key PUBLIC_BASE_URL https://example.test
set_env_key CADDY_SITE_ADDRESS example.test

assert_contains() {
  local hay="$1" needle="$2" msg="$3"
  [[ "$hay" == *"$needle"* ]] || { echo "$msg" >&2; exit 1; }
}

# --- Fresh install path: empty db dir => prompt for new admin setup ---
echo "[flow] fresh-install admin prompt path"
rm -rf "$DATA_ROOT/postgres"
mkdir -p "$DATA_ROOT/postgres"

_prompt_calls=0
prompt() {
  local label="$1"
  case "$label" in
    'Admin username') echo "newadmin" ;;
    'Admin display name') echo "New Admin" ;;
    *) echo "" ;;
  esac
}
prompt_secret() {
  local label="$1"
  if [[ "$label" == 'Admin password' ]]; then
    echo "newpass123"
  else
    echo ""
  fi
}
prompt_fresh_admin_setup
[[ "$ROOT_ADMIN_USERNAME" == "newadmin" ]] || { echo "fresh admin username not captured" >&2; exit 1; }
[[ "$ROOT_ADMIN_DISPLAY_NAME" == "New Admin" ]] || { echo "fresh admin display not captured" >&2; exit 1; }
[[ "$ROOT_ADMIN_PASSWORD" == "newpass123" ]] || { echo "fresh admin password not captured" >&2; exit 1; }
[[ "$(get_env_key ADMIN_USERNAME)" == "newadmin" ]] || { echo "ADMIN_USERNAME not updated for fresh path" >&2; exit 1; }

# --- Existing install path: no DB password auto-generation and DB URL preserved host/db ---
echo "[flow] existing-install env preservation path"
mkdir -p "$DATA_ROOT/postgres"
echo "PG_VERSION" > "$DATA_ROOT/postgres/PG_VERSION"
set_env_key POSTGRES_PASSWORD existing_db_password
set_env_key DATABASE_URL postgres://grishcord:existing_db_password@postgres:5432/grishcord

prompt() {
  local label="$1" def="${2:-}"
  case "$label" in
    'Where should Grishcord DB be located?') echo "$DATA_ROOT" ;;
    'Public hostname (no scheme/path)') echo "example.test" ;;
    *) echo "$def" ;;
  esac
}
prompt_secret() {
  local label="$1"
  case "$label" in
    'Postgres password (leave blank to keep current or auto-generate)') echo "" ;;
    *) echo "" ;;
  esac
}
configure_env_wizard
[[ "$(get_env_key POSTGRES_PASSWORD)" == "existing_db_password" ]] || { echo "existing DB password was changed unexpectedly" >&2; exit 1; }
assert_contains "$(get_env_key DATABASE_URL)" "@postgres:5432/grishcord" "DATABASE_URL connectivity was not preserved"

# --- Existing install path: wrong password retries then success ---
echo "[flow] existing-admin password retry path"
DETECTED_ADMIN_USERS=("rootadmin")
DETECTED_ADMIN_USERNAME="rootadmin"
attempt_file="$TMP_DIR/pass_attempt"
echo 0 > "$attempt_file"
prompt_secret() {
  local label="$1"
  [[ "$label" == *"Existing admin password"* ]] || { echo ""; return; }
  local n
  n="$(cat "$attempt_file")"
  n=$((n+1))
  echo "$n" > "$attempt_file"
  if [[ $n -eq 1 ]]; then
    echo "wrongpass"
  else
    echo "correctpass"
  fi
}
verify_admin_password_with_db() {
  local _u="$1" p="$2"
  [[ "$p" == "correctpass" ]]
}
retry_input=$'Y\n'
set +e
retry_out="$(prompt_existing_admin_password <<<"$retry_input" 2>&1)"
retry_rc=$?
set -e
[[ $retry_rc -eq 0 ]] || { echo "existing password retry flow did not succeed" >&2; echo "$retry_out" >&2; exit 1; }
[[ "$(cat "$attempt_file")" -ge 2 ]] || { echo "retry flow did not re-prompt password" >&2; exit 1; }
assert_contains "$retry_out" "Admin password verification failed." "wrong-password warning missing"
assert_contains "$retry_out" "Existing admin credentials verified." "success verification log missing"

# --- Existing DB corrupt/unusable path: detect_existing_admin_from_db fails clearly ---
echo "[flow] existing-db unusable failure path"
docker() {
  # Simulate `docker compose ... psql ...` failure with psql-like stderr.
  if [[ "$*" == *"psql"* ]]; then
    printf 'psql: error: relation "users" does not exist\n' >&2
    return 1
  fi
  return 0
}
set +e
fail_out="$(detect_existing_admin_from_db 2>&1)"
fail_rc=$?
set -e
[[ $fail_rc -ne 0 ]] || { echo "unusable DB detection should fail" >&2; exit 1; }
assert_contains "$fail_out" "Failed to inspect existing DB" "missing corrupt-db failure guidance"
assert_contains "$fail_out" "Check DB path integrity and Postgres credentials" "missing operator guidance for corrupt-db"

# --- Ensure obsolete manual prompt text is gone ---
echo "[flow] obsolete prompt removed"
if rg -n "Is there already an admin account in the existing DB" "$ROOT_DIR/install_grishcord.sh" >/dev/null; then
  echo "obsolete existing-admin prompt still present" >&2
  exit 1
fi

echo "[flow] installer fresh/existing flow regression checks passed"
