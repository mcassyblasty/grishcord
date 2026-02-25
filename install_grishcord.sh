#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install][warn] %s\n' "$*" >&2; }
err() { printf '[install][error] %s\n' "$*" >&2; }

prompt() {
  local label="$1"
  local default="${2:-}"
  local out
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " out || true
    printf '%s' "${out:-$default}"
  else
    read -r -p "$label: " out || true
    printf '%s' "$out"
  fi
}

require_bin() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1
}

setup_git_identity() {
  local name email
  name="$(git config --global user.name || true)"
  email="$(git config --global user.email || true)"

  if [[ -n "$name" && -n "$email" ]]; then
    log "git identity already configured as: $name <$email>"
    return 0
  fi

  warn "Git is installed but identity is not fully configured."
  read -r -p "Configure git user.name and user.email now? [Y/n]: " ans || true
  ans="${ans:-Y}"
  if [[ ! "$ans" =~ ^[Yy]$ ]]; then
    warn "Skipping git identity setup. You can configure later with: git config --global user.name/user.email"
    return 0
  fi

  if [[ -z "$name" ]]; then
    name="$(prompt 'Enter git user.name')"
    [[ -n "$name" ]] && git config --global user.name "$name"
  fi
  if [[ -z "$email" ]]; then
    email="$(prompt 'Enter git user.email')"
    [[ -n "$email" ]] && git config --global user.email "$email"
  fi

  name="$(git config --global user.name || true)"
  email="$(git config --global user.email || true)"
  if [[ -z "$name" || -z "$email" ]]; then
    warn "Git identity still incomplete; clone can proceed but commits may fail until configured."
  else
    log "Configured git identity: $name <$email>"
  fi
}

derive_archive_url() {
  local repo_url="$1"
  local base="$repo_url"
  base="${base%.git}"
  printf '%s' "$base/archive/refs/heads/main.tar.gz"
}

install_via_git() {
  local repo_url="$1"
  local target_dir="$2"

  if ! require_bin git; then
    err "git is not installed. Install git or choose curl/wget mode."
    return 1
  fi

  setup_git_identity

  if [[ -d "$target_dir/.git" ]]; then
    log "Existing git repo found in $target_dir; updating via pull."
    git -C "$target_dir" pull --ff-only
  elif [[ -d "$target_dir" && -n "$(find "$target_dir" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    err "Target directory exists and is not empty: $target_dir"
    return 1
  else
    mkdir -p "$(dirname "$target_dir")"
    log "Cloning $repo_url into $target_dir"
    git clone --depth 1 "$repo_url" "$target_dir"
  fi
}

extract_archive() {
  local archive_path="$1"
  local target_dir="$2"

  if [[ -d "$target_dir" && -n "$(find "$target_dir" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    err "Target directory exists and is not empty: $target_dir"
    return 1
  fi

  mkdir -p "$target_dir"
  tar -xzf "$archive_path" -C "$target_dir" --strip-components=1
}

install_via_wget() {
  local archive_url="$1"
  local target_dir="$2"

  if ! require_bin wget; then
    err "wget is not installed. Install wget or choose curl/git mode."
    return 1
  fi

  local tmp
  tmp="$(mktemp /tmp/grishcord.XXXXXX.tar.gz)"
  log "Downloading archive via wget: $archive_url"
  wget -O "$tmp" "$archive_url"
  extract_archive "$tmp" "$target_dir"
  rm -f "$tmp"
}

install_via_curl() {
  local archive_url="$1"
  local target_dir="$2"

  if ! require_bin curl; then
    err "curl is not installed. Install curl or choose wget/git mode."
    return 1
  fi

  local tmp
  tmp="$(mktemp /tmp/grishcord.XXXXXX.tar.gz)"
  log "Downloading archive via curl: $archive_url"
  curl -fL --retry 3 --connect-timeout 10 -o "$tmp" "$archive_url"
  extract_archive "$tmp" "$target_dir"
  rm -f "$tmp"
}

main() {
  log "Grishcord installer"
  local repo_url target_dir method archive_url

  repo_url="$(prompt 'Repository git URL' 'https://github.com/example/grishcord.git')"
  target_dir="$(prompt 'Install directory' "$HOME/grishcord")"

  while true; do
    method="$(prompt 'Install method (git/wget/curl)' 'git')"
    case "${method,,}" in
      git|wget|curl) method="${method,,}"; break ;;
      *) warn "Please choose one of: git, wget, curl." ;;
    esac
  done

  if [[ "$method" == "git" ]]; then
    install_via_git "$repo_url" "$target_dir"
  else
    archive_url="$(prompt 'Archive URL (.tar.gz)' "$(derive_archive_url "$repo_url")")"
    if [[ "$method" == "wget" ]]; then
      install_via_wget "$archive_url" "$target_dir"
    else
      install_via_curl "$archive_url" "$target_dir"
    fi
  fi

  log "Install complete: $target_dir"
  cat <<NEXT

Next steps:
  cd "$target_dir"
  cp .env.example .env
  ./scripts/grishcordctl.sh doctor
  ./scripts/grishcordctl.sh start
NEXT
}

main "$@"
