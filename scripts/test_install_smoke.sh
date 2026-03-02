#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/grishcord-install-smoke.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

export GRISHCORD_INSTALL_LIB_ONLY=1
# shellcheck disable=SC1091
source "$ROOT_DIR/install_grishcord.sh"

APP_DIR="$ROOT_DIR"
ENV_FILE="$TMP_DIR/.env"
: > "$ENV_FILE"

echo "[smoke] validating set_env_key create/update"
set +e
create_out="$(set_env_key TEST_KEY one 2>&1)"
create_rc=$?
set -e
[[ $create_rc -eq 0 ]] || { echo "set_env_key create failed: $create_out" >&2; exit 1; }
grep -q '^TEST_KEY=one$' "$ENV_FILE" || { echo "missing TEST_KEY create" >&2; exit 1; }
[[ "$create_out" != *"root bootstrap failed"* ]] || { echo "unexpected bootstrap error output" >&2; exit 1; }

set +e
update_out="$(set_env_key TEST_KEY two 2>&1)"
update_rc=$?
set -e
[[ $update_rc -eq 0 ]] || { echo "set_env_key update failed: $update_out" >&2; exit 1; }
grep -q '^TEST_KEY=two$' "$ENV_FILE" || { echo "missing TEST_KEY update" >&2; exit 1; }
[[ "$(grep -c '^TEST_KEY=' "$ENV_FILE")" -eq 1 ]] || { echo "TEST_KEY duplicated" >&2; exit 1; }
[[ "$update_out" != *"root bootstrap failed"* ]] || { echo "unexpected bootstrap error output" >&2; exit 1; }

echo "[smoke] validating bootstrap_root_admin failure path"
ROOT_ADMIN_USERNAME="rootadmin"
ROOT_ADMIN_DISPLAY_NAME="Root Admin"
ROOT_ADMIN_PASSWORD="secret"

curl() {
  local out_file=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-o" ]]; then
      out_file="$2"
      shift 2
      continue
    fi
    shift
  done
  if [[ -n "$out_file" ]]; then
    printf '{"error":"mock_failure"}' > "$out_file"
  fi
  printf '500'
}

set +e
bootstrap_out="$(bootstrap_root_admin "http://127.0.0.1:3000" 2>&1)"
bootstrap_rc=$?
set -e
[[ $bootstrap_rc -ne 0 ]] || { echo "bootstrap_root_admin should fail on 500" >&2; exit 1; }
[[ "$bootstrap_out" == *"root bootstrap failed (HTTP 500)"* ]] || { echo "missing bootstrap failure message" >&2; echo "$bootstrap_out" >&2; exit 1; }

echo "[smoke] install script smoke checks passed"
