#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLLAMA_ENV_FILE="$ROOT_DIR/.ollama.env"
DEFAULT_MODEL="gemma3:4b"

usage() {
  cat <<USAGE
Usage: ./scripts/ollamactrl.sh <command>

Commands:
  install   Install/update Ollama, configure model path + localhost bind, pull a model
  update    Update Ollama and optionally clear/re-pull models
  start     Enable and start ollama service
  stop      Stop ollama service
  help      Show this help
USAGE
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This action requires root. Re-run with sudo/root." >&2
    exit 1
  fi
}

load_env() {
  [[ -f "$OLLAMA_ENV_FILE" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$OLLAMA_ENV_FILE"
  set +a
}

save_env() {
  local models="$1"
  local model="$2"
  cat > "$OLLAMA_ENV_FILE" <<ENV
OLLAMA_MODELS=$models
OLLAMA_MODEL=$model
ENV
  chmod 600 "$OLLAMA_ENV_FILE" 2>/dev/null || true
  echo "Saved config to $OLLAMA_ENV_FILE"
}

install_ollama_binary() {
  need_cmd curl
  echo "Installing/updating Ollama via official installer..."
  run_root sh -c 'curl -fsSL https://ollama.com/install.sh | sh'
}

configure_service() {
  local models_path="$1"
  run_root mkdir -p "$models_path"
  local owner_group
  if getent passwd ollama >/dev/null 2>&1; then
    owner_group="ollama:ollama"
  else
    owner_group="$(id -un):$(id -gn)"
  fi
  run_root chown -R "$owner_group" "$models_path" || true
  run_root mkdir -p /etc/systemd/system/ollama.service.d
  run_root tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<OVR
[Service]
Environment="OLLAMA_MODELS=$models_path"
Environment="OLLAMA_HOST=127.0.0.1:11434"
OVR
  run_root systemctl daemon-reload
  run_root systemctl enable ollama
  run_root systemctl restart ollama
}

pull_model() {
  local model="$1"
  echo "Pulling model: $model"
  ollama pull "$model"
}

cmd_install() {
  load_env
  local current_models="${OLLAMA_MODELS:-/var/lib/ollama/models}"
  local current_model="${OLLAMA_MODEL:-$DEFAULT_MODEL}"

  read -r -p "Where should Ollama models be stored? [$current_models]: " models_path
  models_path="${models_path:-$current_models}"

  read -r -p "Which Ollama model should be used/pulled? [$current_model]: " model
  model="${model:-$current_model}"

  install_ollama_binary
  configure_service "$models_path"
  pull_model "$model"
  save_env "$models_path" "$model"
  echo "Done. Ollama is enabled, restarted, bound to 127.0.0.1:11434."
}

cmd_update() {
  load_env
  local models_path="${OLLAMA_MODELS:-/var/lib/ollama/models}"
  local current_model="${OLLAMA_MODEL:-$DEFAULT_MODEL}"

  install_ollama_binary

  local keep="Y"
  read -r -p "Do you want to keep the model(s) you have right now? [Y/n]: " keep
  keep="${keep:-Y}"

  if [[ "$keep" =~ ^[Nn]$ ]]; then
    echo "WARNING: You chose to delete downloaded Ollama models from: $models_path"
    local confirm
    read -r -p "Type DELETE to confirm model deletion: " confirm
    if [[ "$confirm" != "DELETE" ]]; then
      echo "Confirmation not received; aborting model deletion."
      exit 1
    fi
    run_root mkdir -p "$models_path"
    run_root find "$models_path" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

    local selected
    read -r -p "Which model should be pulled? [$current_model]: " selected
    selected="${selected:-$current_model}"
    configure_service "$models_path"
    pull_model "$selected"
    save_env "$models_path" "$selected"
  else
    configure_service "$models_path"
    save_env "$models_path" "$current_model"
  fi

  run_root systemctl daemon-reload
  run_root systemctl enable ollama
  run_root systemctl restart ollama
  echo "Update complete."
}

cmd_start() {
  run_root systemctl enable ollama
  run_root systemctl start ollama
  echo "ollama service started"
}

cmd_stop() {
  run_root systemctl stop ollama
  echo "ollama service stopped"
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    install) cmd_install ;;
    update) cmd_update ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    help|-h|--help) usage ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
