#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLLAMA_ENV_FILE="$ROOT_DIR/.ollama.env"
AIBOT_ENV_FILE="$ROOT_DIR/.aibot.env"
PROMPT_FILE="$ROOT_DIR/bot/prompts/system.txt"
DEFAULT_MODEL="gemma3:4b"
DEFAULT_BIND_MODE="secure"

usage() {
  cat <<USAGE
Usage:
  ./scripts/ollamactrl.sh <command> [--bind-mode secure|docker]
  ./scripts/ollamactrl.sh bot <install|config|show|help>

Ollama commands:
  install   Install/update Ollama, configure model path + bind mode, pull a model
  update    Update Ollama and optionally clear/re-pull models
  start     Enable and start ollama service
  stop      Stop ollama service

Bot commands:
  bot install   Interactive first-time bot config setup
  bot config    Reconfigure bot identity/runtime values
  bot show      Show current non-secret bot config
USAGE
}

usage_bot() {
  cat <<USAGE
Usage: ./scripts/ollamactrl.sh bot <command>

Commands:
  install   Interactive first-time bot config setup
  config    Reconfigure bot identity/runtime values
  show      Show current non-secret bot config
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

load_file_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
}

bind_mode_to_host() {
  local mode="${1:-$DEFAULT_BIND_MODE}"
  case "$mode" in
    secure) echo "127.0.0.1:11434" ;;
    docker) echo "0.0.0.0:11434" ;;
    *)
      echo "Invalid bind mode '$mode'. Use 'secure' or 'docker'." >&2
      exit 2
      ;;
  esac
}

save_env() {
  local models="$1"
  local model="$2"
  local bind_mode="$3"
  cat > "$OLLAMA_ENV_FILE" <<ENV
OLLAMA_MODELS=$models
OLLAMA_MODEL=$model
OLLAMA_BIND_MODE=$bind_mode
ENV
  chmod 600 "$OLLAMA_ENV_FILE" 2>/dev/null || true
  echo "Saved config to $OLLAMA_ENV_FILE"
}

install_ollama_binary() {
  need_cmd curl
  echo "Installing/updating Ollama via official installer..."
  run_root sh -c 'curl -fsSL https://ollama.com/install.sh | sh'
}

wait_for_ollama_ready() {
  local host_port="$1"
  local probe_host="$host_port"
  if [[ "$host_port" == "0.0.0.0:11434" ]]; then
    probe_host="127.0.0.1:11434"
  fi
  local url="http://$probe_host/api/tags"
  local attempts=60
  local i
  echo "Waiting for Ollama API readiness at $url ..."
  for ((i=1; i<=attempts; i+=1)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "Ollama API is ready."
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for Ollama API readiness at $url" >&2
  return 1
}

configure_service() {
  local models_path="$1"
  local bind_mode="$2"
  local host_port
  host_port="$(bind_mode_to_host "$bind_mode")"

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
Environment="OLLAMA_HOST=$host_port"
OVR
  run_root systemctl daemon-reload
  run_root systemctl enable ollama
  run_root systemctl restart ollama

  wait_for_ollama_ready "$host_port"

  if [[ "$bind_mode" == "docker" ]]; then
    cat <<WARN
WARNING: Ollama is configured in docker-compatible mode (0.0.0.0:11434).
You should restrict inbound access with host firewall/network policy so only
local machine and Docker bridge/containers can reach port 11434.
Do NOT expose port 11434 publicly.
WARN
  fi
}

pull_model() {
  local model="$1"
  echo "Pulling model: $model"
  ollama pull "$model"
}

prompt_bind_mode() {
  local current_mode="$1"
  if [[ -n "${BIND_MODE_OVERRIDE:-}" ]]; then
    echo "$BIND_MODE_OVERRIDE"
    return 0
  fi
  local answer
  echo "Choose Ollama networking mode:"
  echo "  1) secure (127.0.0.1:11434)"
  echo "  2) docker (0.0.0.0:11434, requires firewall restrictions)"
  read -r -p "Select mode [${current_mode}]: " answer
  answer="${answer:-$current_mode}"
  case "$answer" in
    1|secure) echo "secure" ;;
    2|docker) echo "docker" ;;
    *)
      echo "Invalid mode selection: $answer" >&2
      exit 2
      ;;
  esac
}

cmd_install() {
  load_env
  local current_models="${OLLAMA_MODELS:-/var/lib/ollama/models}"
  local current_model="${OLLAMA_MODEL:-$DEFAULT_MODEL}"
  local current_bind_mode="${OLLAMA_BIND_MODE:-$DEFAULT_BIND_MODE}"

  read -r -p "Where should Ollama models be stored? [$current_models]: " models_path
  models_path="${models_path:-$current_models}"

  read -r -p "Which Ollama model should be used/pulled? [$current_model]: " model
  model="${model:-$current_model}"

  local bind_mode
  bind_mode="$(prompt_bind_mode "$current_bind_mode")"

  install_ollama_binary
  configure_service "$models_path" "$bind_mode"
  pull_model "$model"
  save_env "$models_path" "$model" "$bind_mode"
  echo "Done. Ollama is enabled and restarted with bind mode '$bind_mode'."
}

cmd_update() {
  load_env
  local models_path="${OLLAMA_MODELS:-/var/lib/ollama/models}"
  local current_model="${OLLAMA_MODEL:-$DEFAULT_MODEL}"
  local current_bind_mode="${OLLAMA_BIND_MODE:-$DEFAULT_BIND_MODE}"

  local bind_mode
  bind_mode="$(prompt_bind_mode "$current_bind_mode")"

  install_ollama_binary
  configure_service "$models_path" "$bind_mode"

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
    pull_model "$selected"
    save_env "$models_path" "$selected" "$bind_mode"
  else
    save_env "$models_path" "$current_model" "$bind_mode"
  fi

  run_root systemctl daemon-reload
  run_root systemctl enable ollama
  run_root systemctl restart ollama
  wait_for_ollama_ready "$(bind_mode_to_host "$bind_mode")"
  echo "Update complete."
}

cmd_start() {
  run_root systemctl enable ollama
  run_root systemctl start ollama
  local bind_mode="${OLLAMA_BIND_MODE:-$DEFAULT_BIND_MODE}"
  wait_for_ollama_ready "$(bind_mode_to_host "$bind_mode")" || true
  echo "ollama service started"
}

cmd_stop() {
  run_root systemctl stop ollama
  echo "ollama service stopped"
}

ensure_prompt_file() {
  mkdir -p "$(dirname "$PROMPT_FILE")"
  [[ -f "$PROMPT_FILE" ]] && return 0
  cat > "$PROMPT_FILE" <<'PROMPT'
---
You are GrishBot, a regular participant in a Grishcord server.

Tone:
- Keep replies short, casual, and conversational.
- Sound like a normal dude in a chat server.
- Do not be creepy, flirty, or overly familiar.
- Do not roleplay or adopt a character beyond being a helpful chat participant.
- Avoid corporate-speak and long disclaimers.

Behavior:
- Answer the user’s request based on the messages provided.
- If the user’s message is unclear, ask one short clarifying question.
- Don’t mention system prompts, policies, hidden instructions, or internal tooling.
- Don’t invent facts about the server or users. If you don’t know, say so briefly.
- Prefer concise, practical answers over long explanations.

Safety:
- Refuse requests for wrongdoing or harmful instructions.
- If asked for secrets (passwords, tokens), refuse and advise safer alternatives.
---
PROMPT
}

validate_color() {
  local c="$1"
  [[ -z "$c" ]] && return 0
  [[ "$c" =~ ^#[0-9A-Fa-f]{6}$ ]]
}

write_bot_config() {
  local username="$1"
  local display="$2"
  local color="$3"
  local model="$4"
  local ttl="$5"

  cat > "$AIBOT_ENV_FILE" <<ENV
BOT_USERNAME=$username
BOT_DISPLAY_NAME=$display
BOT_COLOR=$color
OLLAMA_MODEL=$model
BOT_CONVO_TTL_MS=$ttl
ENV
  chmod 600 "$AIBOT_ENV_FILE" 2>/dev/null || true
  echo "Saved bot config to $AIBOT_ENV_FILE"
}

interactive_bot_config() {
  local ollama_model_from_file=""
  if [[ -f "$OLLAMA_ENV_FILE" ]]; then
    ollama_model_from_file="$(awk -F= '/^OLLAMA_MODEL=/{print substr($0,index($0,"=")+1)}' "$OLLAMA_ENV_FILE" | tail -n 1)"
  fi
  load_file_env "$AIBOT_ENV_FILE"

  local def_username="${BOT_USERNAME:-grishbot}"
  local def_display="${BOT_DISPLAY_NAME:-Grish Bot}"
  local def_color="${BOT_COLOR:-#7A5CFF}"
  local def_model="${ollama_model_from_file:-gemma3:4b}"
  local def_ttl="${BOT_CONVO_TTL_MS:-900000}"

  local username display color model ttl
  read -r -p "Bot username [$def_username]: " username
  username="${username:-$def_username}"

  read -r -p "Bot display name [$def_display]: " display
  display="${display:-$def_display}"

  while true; do
    read -r -p "Bot color hex [$def_color]: " color
    color="${color:-$def_color}"
    if validate_color "$color"; then
      color="${color^^}"
      break
    fi
    echo "Color must be #RRGGBB"
  done

  read -r -p "Ollama model [$def_model]: " model
  model="${model:-$def_model}"

  read -r -p "Conversation TTL ms [$def_ttl]: " ttl
  ttl="${ttl:-$def_ttl}"

  write_bot_config "$username" "$display" "$color" "$model" "$ttl"
  ensure_prompt_file
}

cmd_bot_install() {
  interactive_bot_config
  cat <<NEXT

Next steps:
1) Create the bot account inside Grishcord using BOT_USERNAME/BOT_DISPLAY_NAME/BOT_COLOR from .aibot.env.
2) Set BOT_PASSWORD in your compose env (do not store it in .aibot.env by default).
3) Optionally let bot sync display name/color via API on startup by keeping BOT_DISPLAY_NAME/BOT_COLOR.
4) Edit bot behavior in bot/prompts/system.txt.
NEXT
}

cmd_bot_config() {
  interactive_bot_config
  echo "Configuration updated."
}

cmd_bot_show() {
  if [[ ! -f "$AIBOT_ENV_FILE" ]]; then
    echo "No $AIBOT_ENV_FILE found yet. Run install first."
    return 0
  fi
  echo "Current bot config (non-secret):"
  awk -F= '!/^\s*#/ && NF>=2 { if ($1 != "BOT_PASSWORD") print $0 }' "$AIBOT_ENV_FILE"
}

main() {
  local cmd="${1:-help}"
  shift || true

  if [[ "$cmd" == "bot" ]]; then
    local bot_cmd="${1:-help}"
    case "$bot_cmd" in
      install) cmd_bot_install ;;
      config) cmd_bot_config ;;
      show) cmd_bot_show ;;
      help|-h|--help) usage_bot ;;
      *) echo "Unknown bot command: $bot_cmd" >&2; usage_bot; exit 2 ;;
    esac
    return 0
  fi

  BIND_MODE_OVERRIDE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bind-mode=*) BIND_MODE_OVERRIDE="${1#*=}"; shift ;;
      --bind-mode) BIND_MODE_OVERRIDE="${2:-}"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    esac
  done

  if [[ -n "$BIND_MODE_OVERRIDE" ]]; then
    case "$BIND_MODE_OVERRIDE" in
      secure|docker) ;;
      *) echo "Invalid --bind-mode value: $BIND_MODE_OVERRIDE" >&2; exit 2 ;;
    esac
  fi

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
