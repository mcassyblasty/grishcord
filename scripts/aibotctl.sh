#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AIBOT_ENV_FILE="$ROOT_DIR/.aibot.env"
OLLAMA_ENV_FILE="$ROOT_DIR/.ollama.env"
PROMPT_FILE="$ROOT_DIR/bot/prompts/system.txt"

usage() {
  cat <<USAGE
Usage: ./scripts/aibotctl.sh <command>

Commands:
  install   Interactive first-time bot config setup
  config    Reconfigure bot identity/runtime values
  show      Show current non-secret bot config
  help      Show this help
USAGE
}

load_file_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
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

write_config() {
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

interactive_config() {
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

  write_config "$username" "$display" "$color" "$model" "$ttl"
  ensure_prompt_file
}

cmd_install() {
  interactive_config
  cat <<NEXT

Next steps:
1) Create the bot account inside Grishcord using BOT_USERNAME/BOT_DISPLAY_NAME/BOT_COLOR from .aibot.env.
2) Set BOT_PASSWORD in your compose env (do not store it in .aibot.env by default).
3) Optionally let bot sync display name/color via API on startup by keeping BOT_DISPLAY_NAME/BOT_COLOR.
4) Edit bot behavior in bot/prompts/system.txt.
NEXT
}

cmd_config() {
  interactive_config
  echo "Configuration updated."
}

cmd_show() {
  if [[ ! -f "$AIBOT_ENV_FILE" ]]; then
    echo "No $AIBOT_ENV_FILE found yet. Run install first."
    return 0
  fi
  echo "Current bot config (non-secret):"
  awk -F= '!/^\s*#/ && NF>=2 { if ($1 != "BOT_PASSWORD") print $0 }' "$AIBOT_ENV_FILE"
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    install) cmd_install ;;
    config) cmd_config ;;
    show) cmd_show ;;
    help|-h|--help) usage ;;
    *) echo "Unknown command: $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
