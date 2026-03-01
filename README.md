# Grishcord

Minimal private Discord-like web app scaffold with Docker Compose, Postgres, LiveKit, and coturn.

## Install helper
- `./install_grishcord.sh` (interactive installer usable from anywhere: choose git/wget/curl and target directory)
- If `git` is selected and identity is not configured, the installer guides setup for `git config --global user.name` and `user.email`.
- Installer records update metadata in `.grishcord-install.env` so `grishcordctl.sh update-start` can update source code before rebuilding.

## Operations
- `./scripts/grishcordctl.sh start` (verbose build/start with live timers + readiness waits)
- `./scripts/grishcordctl.sh restart` (fast service restart + readiness waits)
- `./scripts/grishcordctl.sh stop` (verbose stop)
- `./scripts/grishcordctl.sh update-start` (pull, rebuild, start with live timers)
- `./scripts/grishcordctl.sh status` (compose status + LAN URL)
- `./scripts/grishcordctl.sh logs` (recent stack logs)
- `./scripts/grishcordctl.sh doctor` (check prerequisites + compose diagnostics)
- `./scripts/run_grishcord.sh [command]` (compat wrapper; default `start`)

## Docs
- `docs/GRISHCORD_SPEC.tex`
- `docs/DEPLOYMENT.md`
- `docs/NETWORKING.md`
- `docs/OPERATIONS.tex`

## Versioning
- Canonical app version: `VERSION`
- Release history: `docs/CHANGELOG.md`
- Runtime source of truth in containers: backend reads `/app/VERSION` by default.
- Optional override: set `APP_VERSION` only if you intentionally want to override `VERSION`.


## Audio Assets
- Place notification WAV files in `frontend/audio/` (served by the frontend container at `/audio/...`).
- Current frontend alert lookup includes message and notification variants such as `message_received.wav` and `notification.wav`.

## Security-related environment notes
- `PUBLIC_BASE_URL` should match your externally reachable app URL.
- `CADDY_SITE_ADDRESS` must be your DNS hostname only (no `https://` or path) for automatic HTTPS certificates and HTTP->HTTPS redirect.
- `CORS_ORIGINS` should be a comma-separated allowlist of trusted frontend origins permitted to call the API with credentials.
- Authentication and recovery endpoints are rate-limited server-side; repeated failures receive HTTP `429` with `Retry-After`.

## Compose database host note
- In Docker Compose, `DATABASE_URL` must target the service hostname `postgres` (not `localhost` / `127.0.0.1`).


## Upload limits
- Supports image attachments and `.zip` attachments.
- Default backend upload cap is 100MB via `MAX_UPLOAD_BYTES` in `.env`.


## Cloudflare / Internet edge note
- If you use Cloudflare proxy and see **522**, the edge cannot reach your origin on 80/443. Ensure host firewall allows inbound TCP 80/443, router forwards 80/443 to this host, and Cloudflare SSL mode is **Full (strict)** once certs are issued.
- Cloudflare **Full** / **Full (strict)** require origin HTTPS on 443 with a certificate; **Flexible** uses HTTP to origin. If issuance fails while proxied, temporarily switch DNS record to DNS-only, issue certs, then re-enable proxy with **Full (strict)**.

## AI bot (notification-gated normal user)

The AI bot runs as a separate service (`bot/`) and authenticates like a regular Grishcord user account.

### Hard trigger gate behavior
- The bot listens to WebSocket `notification` events only.
- It only reacts to notification events in server channels (`mode=channel`), which correspond to mention/reply notifications.
- It ignores all DM notifications (`mode=dm`).
- It does **not** scan raw message firehose events for triggers.

### Configure Ollama on the host VM
Use:
- `./scripts/ollamactrl.sh install`
- `./scripts/ollamactrl.sh update`
- `./scripts/ollamactrl.sh start`
- `./scripts/ollamactrl.sh stop`

`install` and `update` use:
- `curl -fsSL https://ollama.com/install.sh | sh`

`install` writes host-local Ollama settings to `.ollama.env` (model path and model name), configures systemd override, and keeps Ollama bound to `127.0.0.1:11434`.


### Ollama networking modes (secure vs docker)
`./scripts/ollamactrl.sh` supports two bind modes and persists your choice in `.ollama.env` (`OLLAMA_BIND_MODE`):

- **secure** (default): Ollama binds to `127.0.0.1:11434`.
  - Best default for host security.
  - A bot container cannot reach host-loopback through `host.docker.internal`.
  - Use this mode when the bot runs on the host network/process namespace (or outside Docker on the host).

- **docker**: Ollama binds to `0.0.0.0:11434`.
  - Needed for standard Docker bridge access from the bot container using `http://host.docker.internal:11434`.
  - Keep access restricted with host firewall/network policy so only local host + Docker networks can reach port `11434`.
  - Do **not** expose port `11434` to public networks.

The bot compose service is already configured with `extra_hosts: ["host.docker.internal:host-gateway"]` and defaults to `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

`ollamactrl` now waits for the Ollama API to become ready before model pulls, reducing restart/pull race failures.

### Configure bot identity/runtime defaults
Use:
- `./scripts/aibotctl.sh install`
- `./scripts/aibotctl.sh config`
- `./scripts/aibotctl.sh show`

This writes `.aibot.env` (editable later) with:
- `BOT_USERNAME`
- `BOT_DISPLAY_NAME`
- `BOT_COLOR`
- `OLLAMA_MODEL`
- `BOT_CONVO_TTL_MS`

`BOT_PASSWORD` is intentionally not written there by default.

### Create the bot account in Grishcord (normal flow)
1. Create an invite token as an admin in Grishcord.
2. Register the dedicated bot account through normal invite + registration flow.
3. Set the profile display name/color to match `.aibot.env` values (or let startup profile sync do it via API).

### Set bot password securely
Set `BOT_PASSWORD` in your runtime compose environment (for example `.env` on the deployment host), not in git-committed files.

### Edit system prompt
Edit `bot/prompts/system.txt`.
- The bot reads this file at runtime when generating replies.
- No rebuild is required by default because compose points the bot to `/config/bot/prompts/system.txt` (repo-mounted read-only into the container). Restart the bot service after edits if needed.

### Bot env vars
Required:
- `GRISHCORD_BASE_URL` (default: `http://backend:3000`)
- `BOT_USERNAME`
- `BOT_PASSWORD`
- `OLLAMA_BASE_URL` (default in compose: `http://host.docker.internal:11434`)
- `OLLAMA_MODEL`

Optional:
- `BOT_OLLAMA_TIMEOUT_MS` (default `30000`)
- `BOT_MAX_REPLY_CHARS` (default `1800`)
- `BOT_CONTEXT_MAX_MESSAGES` (default `30`)
- `BOT_CONVO_TTL_MS` (default `900000`)
- `BOT_RATE_LIMIT_MS` (default `2000`)
- `BOT_MAX_CONCURRENCY_PER_CHANNEL` (default `1`)
- `BOT_PROMPT_FILE` (default `/config/bot/prompts/system.txt`)

### Manual verification checklist (acceptance)
1. Start Grishcord + bot (`./scripts/grishcordctl.sh start`) and confirm bot logs show successful login and WebSocket connection.
2. In a server text channel, send a normal message with no mention/reply: bot should **not** respond.
3. Ping `@<bot_username>` in a server channel: bot should respond as a **reply** to that message.
4. Reply to the bot’s message in a server channel: bot should respond.
5. Send a DM to the bot account: bot should **not** respond.
6. Wait longer than `BOT_CONVO_TTL_MS` (default 15 minutes), then ping again: bot should treat it as a fresh context and avoid referencing expired conversation memory.
