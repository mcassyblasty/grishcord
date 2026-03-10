#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/grishcord-main-gate.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

export GRISHCORD_INSTALL_LIB_ONLY=1
# shellcheck disable=SC1091
source "$ROOT_DIR/install_grishcord.sh"

assert_contains() {
  local hay="$1" needle="$2" msg="$3"
  [[ "$hay" == *"$needle"* ]] || { echo "$msg" >&2; exit 1; }
}

run_main_scenario() {
  local mode="$1" verify_behavior="$2"
  local repo="$TMP_DIR/repo-$mode-$verify_behavior"
  local envf="$repo/.env"
  local logf="$TMP_DIR/order-$mode-$verify_behavior.log"
  mkdir -p "$repo"
  : > "$logf"

  require_bin() { :; }
  resolve_app_dir() {
    APP_DIR="$repo"
    ENV_FILE="$envf"
    INSTALL_ENV_FILE="$repo/.install.env"
  }
  load_install_env() { :; }
  provision_repo_checkout() { mkdir -p "$APP_DIR"; }
  ensure_env_file() {
    : > "$ENV_FILE"
    set_env_key POSTGRES_USER grishcord
    set_env_key POSTGRES_DB grishcord
    set_env_key POSTGRES_PASSWORD existing_db_password
    set_env_key JWT_SECRET existing_jwt_secret_which_is_long_enough_123456
    set_env_key BOOTSTRAP_ROOT_TOKEN existing_bootstrap_token_which_is_long_enough
    set_env_key CADDY_SITE_ADDRESS example.test
    set_env_key PUBLIC_BASE_URL https://example.test
  }
  prompt() {
    local label="$1" def="${2:-}"
    case "$label" in
      'Where should Grishcord be located?') echo "$repo" ;;
      'Where should Grishcord DB be located?') echo "$TMP_DIR/data-$mode-$verify_behavior" ;;
      *) echo "$def" ;;
    esac
  }
  prompt_secret() {
    local label="$1"
    case "$label" in
      'Admin password') echo "newpass123" ;;
      *) echo "" ;;
    esac
  }
  inspect_postgres_data_dir() {
    if [[ "$mode" == "existing" ]]; then
      echo "populated"
    else
      echo "empty"
    fi
  }
  ensure_existing_db_credentials() {
    echo "ensure_existing_db_credentials" >> "$logf"
  }
  docker() {
    if [[ "$*" == *" up -d postgres"* ]]; then
      echo "startup_postgres_only" >> "$logf"
      return 0
    fi
    if [[ "$*" == *"up -d --build --remove-orphans postgres backend frontend caddy"* ]]; then
      echo "startup_full_stack" >> "$logf"
      return 0
    fi
    if [[ "$*" == *" up -d --build bot"* ]]; then
      echo "startup_bot" >> "$logf"
      return 0
    fi
    return 0
  }
  wait_postgres_ready() { echo "wait_postgres_ready" >> "$logf"; return 0; }
  detect_existing_admin_from_db() {
    echo "detect_existing_admin" >> "$logf"
    INSTALL_MODE="existing"
    DETECTED_ADMIN_USERNAME="rootadmin"
  }
  prompt_existing_admin_password() {
    echo "verify_existing_admin" >> "$logf"
    if [[ "$verify_behavior" == "abort" ]]; then
      exit 1
    fi
    return 0
  }
  prompt_fresh_admin_setup() { echo "fresh_admin_setup" >> "$logf"; ROOT_ADMIN_USERNAME='freshadmin'; ROOT_ADMIN_DISPLAY_NAME='Fresh Admin'; ROOT_ADMIN_PASSWORD='freshpass'; }
  configure_env_wizard() { echo "configure_env_wizard" >> "$logf"; }
  preflight_compose_sanity() { echo "preflight" >> "$logf"; }
  wait_http_ok() { echo "wait_http_ok" >> "$logf"; return 0; }
  bootstrap_root_admin() { echo "bootstrap_root_admin" >> "$logf"; }
  login_admin() { echo "login_admin" >> "$logf"; }
  configure_ai() { echo "configure_ai" >> "$logf"; ENABLE_AI="false"; AI_SETUP_STATUS="skipped"; }
  write_install_env() { echo "write_install_env" >> "$logf"; }

  set +e
  main_out="$(main 2>&1)"
  main_rc=$?
  set -e

  printf '%s' "$main_out" > "$TMP_DIR/out-$mode-$verify_behavior.log"
  SCENARIO_LOG="$logf"
  SCENARIO_OUT="$TMP_DIR/out-$mode-$verify_behavior.log"
  SCENARIO_RC="$main_rc"
}

echo "[gate] existing install verifies before full startup"
run_main_scenario existing success
[[ "$SCENARIO_RC" -eq 0 ]] || { echo "existing-success scenario failed" >&2; cat "$SCENARIO_OUT" >&2; exit 1; }
order="$(cat "$SCENARIO_LOG")"
assert_contains "$order" "verify_existing_admin" "existing path did not verify admin"
verify_line="$(rg -n '^verify_existing_admin$' "$SCENARIO_LOG" | cut -d: -f1)"
full_line="$(rg -n '^startup_full_stack$' "$SCENARIO_LOG" | cut -d: -f1)"
[[ -n "$verify_line" && -n "$full_line" && "$verify_line" -lt "$full_line" ]] || { echo "full startup occurred before existing-admin verification" >&2; cat "$SCENARIO_LOG" >&2; exit 1; }

if rg -n '^fresh_admin_setup$' "$SCENARIO_LOG" >/dev/null; then
  echo "existing path should not invoke fresh-admin setup" >&2
  cat "$SCENARIO_LOG" >&2
  exit 1
fi
echo "[gate] existing install abort stops continuation"
run_main_scenario existing abort
[[ "$SCENARIO_RC" -ne 0 ]] || { echo "existing-abort scenario should fail" >&2; exit 1; }
if rg -n '^startup_full_stack$' "$SCENARIO_LOG" >/dev/null; then
  echo "full startup should not run after existing-admin verification abort" >&2
  cat "$SCENARIO_LOG" >&2
  exit 1
fi

echo "[gate] fresh install bypasses existing-admin verification"
run_main_scenario fresh success
[[ "$SCENARIO_RC" -eq 0 ]] || { echo "fresh scenario failed" >&2; cat "$SCENARIO_OUT" >&2; exit 1; }
if rg -n '^verify_existing_admin$' "$SCENARIO_LOG" >/dev/null; then
  echo "fresh path should not invoke existing-admin verification" >&2
  cat "$SCENARIO_LOG" >&2
  exit 1
fi
assert_contains "$(cat "$SCENARIO_LOG")" "fresh_admin_setup" "fresh path did not trigger new-admin setup"

if rg -n '^startup_postgres_only$' "$SCENARIO_LOG" >/dev/null; then
  echo "fresh path should not start postgres-only verification flow" >&2
  cat "$SCENARIO_LOG" >&2
  exit 1
fi

echo "[gate] installer startup gating checks passed"
