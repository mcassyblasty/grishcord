# Grishcord

Minimal private Discord-like web app scaffold with Docker Compose and Postgres.

## Install helper
- `./install_grishcord.sh` (interactive installer usable from anywhere)
- If `git` is selected and identity is not configured, the installer guides setup for `git config --global user.name` and `user.email`.
- Installer records update metadata in `.grishcord-install.env` so `grishcordctl.sh update-start` can update source code before rebuilding.
- Installer defaults: repo path `/home/grishcord/grishcord`, DB data root `/mnt/grishcord/`, source `git`, repo URL `https://github.com/mcassyblasty/grishcord.git`.
- Full local bootstrap includes guided `.env` setup, admin bootstrap/login, and optional AI (Ollama + GrishBot) flow.

### `./install_grishcord.sh` interactive bootstrap
The installer asks for:
- Install intent (`normal` rerun/reconfigure vs `replace-source` to refresh app code from git/archive while preserving DB/data)
- Grishcord repo location, DB data root, and repo source (git/wget/curl/local-archive)
- If `git` source: git URL
- Public hostname (used for `CADDY_SITE_ADDRESS`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`)
- Postgres password (or blank to keep/generate securely)
- Existing DB/admin is detected automatically from DB state (no manual yes/no prompt)
- Installer fails clearly when a DB path is permission-restricted/unusable/corrupt or not a valid Grishcord schema
- Existing installs: installer prompts for detected admin password and verifies against stored DB hash before continuing to full stack startup (wrong password retries)
- Fresh installs: installer prompts for new admin username/display name/password
- Optional AI enablement (Ollama + bot account)
- If AI enabled: bot username/display name/password/color, plus Ollama install/config prompts for the single secure local endpoint
- AI install defaults the Ollama models path to `${HOST_DATA_ROOT}/models`, lists already-installed models before the model prompt, and skips re-pulling a model that is already present

It writes non-secret rerun defaults to `.install.env` and runtime values to `.env`.
When needed, installer auto-generates secure `JWT_SECRET`, `BOOTSTRAP_ROOT_TOKEN`, and `POSTGRES_PASSWORD` values during the wizard.
Local runtime config files (`.env`, `.install.env`, `.aibot.env`, `.ollama.env`) are intentionally gitignored and should stay private.

Re-run safely at any time:
- `./install_grishcord.sh`

## First-run config
- Recommended: run `./install_grishcord.sh` and follow the guided `.env` wizard (hostname, admin credentials, DB password, secure secret generation).
- Manual fallback: copy `.env.example` to `.env` and set real values before startup.
- Treat `.env` as local-only runtime config: do not commit or ship it in release artifacts.

## Operations
- `./scripts/grishcordctl.sh start` (verbose build/start with live timers + readiness waits)
- `./scripts/grishcordctl.sh restart` (recreate backend/frontend/bot/caddy so `.env` changes apply, then wait for readiness)
- `./scripts/grishcordctl.sh stop` (verbose stop)
- `./scripts/grishcordctl.sh update-start` (pull, rebuild, start with live timers)
- `./scripts/grishcordctl.sh status` (compose status + canonical URL hints)
- `./scripts/grishcordctl.sh logs` (recent stack logs)
- `./scripts/grishcordctl.sh doctor` (check prerequisites + compose diagnostics)
- `make install-sanity` (runs lightweight installer helper sanity checks; temp files + mocked calls, no burn-in/stress)
- `./scripts/aibotctl.sh restart` (force-recreate only the bot service to reload bot modules)

Control split:
- `./scripts/grishcordctl.sh` = stack/app lifecycle and health operations
- `./scripts/aibotctl.sh` = Ollama + GrishBot runtime/config operations

## Docs
- `docs/GRISHCORD_SPEC.tex`
- `docs/DEPLOYMENT.md`
- `docs/NETWORKING.md`
- `docs/OPERATIONS.tex`

## Versioning
- Canonical app version: `VERSION`
- Release history: `docs/CHANGELOG.md`
- Runtime source of truth in containers: backend reads `/app/VERSION` by default.
- Backend container dependencies are lockfile-pinned (`backend/package-lock.json`) and installed via `npm ci --omit=dev` for reproducible builds.
- Optional override: set `APP_VERSION` only if you intentionally want to override `VERSION`.


## Audio Assets
- Place notification WAV files in `frontend/audio/` (served by the frontend container at `/audio/...`).
- Current frontend alert lookup includes message and notification variants such as `message_received.wav` and `notification.wav`.

## Security-sensitive config
- `JWT_SECRET` is required and backend startup now fails if it is missing, too short (<32 chars), or placeholder-like (for example `change-me` or `replace_with_long_random_secret`).
- `BOOTSTRAP_ROOT_TOKEN` is required to authorize unauthenticated `POST /api/bootstrap/root`; when unset/invalid, bootstrap is disabled (`bootstrap_disabled`).
- `POST /api/bootstrap/root` requires header `x-bootstrap-token` matching `BOOTSTRAP_ROOT_TOKEN` and remains closed after the first user exists.
- `grishcordctl` preflights `JWT_SECRET` before start/restart/update-start and aborts early with a clear message if it is invalid.
- `PUBLIC_BASE_URL` and/or `CORS_ORIGINS` must resolve to valid trusted origins (for example `https://chat.example.com`).
- In production/container-style deployments, backend startup fails closed when trusted origin config is empty or invalid.
- `CORS_ORIGINS` should be a comma-separated allowlist of trusted frontend origins permitted to call the API with credentials.
- Session cookies remain `httpOnly` + `sameSite=lax`; `secure` is enabled when `COOKIE_SECURE=true` and TLS is active at the edge (`X-Forwarded-Proto=https`).
- WebSocket connections require a valid session cookie; channel events are scoped to explicit `subscribe` messages (`{"type":"subscribe","channelIds":[...]}`).
- Message history APIs require explicit scope (`channelId` or `dmPeerId`), and `/api/messages/window/:id` returns only a bounded window up to the trigger message.
- Upload downloads are access-checked against attached messages; orphaned uploads are denied by default.
- `CADDY_SITE_ADDRESS` must be your DNS hostname only (no `https://` or path) for automatic HTTPS certificates and HTTP->HTTPS redirect.
- Frontend ships with a system font stack (no Google Fonts request), and edge CSP/header policy is set in `caddy/Caddyfile`.
- Authentication and recovery endpoints are rate-limited server-side; repeated failures receive HTTP `429` with `Retry-After`.

## Compose database host note
- In Docker Compose, `DATABASE_URL` must target the service hostname `postgres` (not `localhost` / `127.0.0.1`).


## Upload limits
- Supports image attachments and `.zip` attachments.
- Default backend upload cap is 100MB via `MAX_UPLOAD_BYTES` in `.env`.
- Unattached uploads are reaped automatically after `UNATTACHED_UPLOAD_TTL_MS` (default 24h), in batches controlled by `UPLOAD_REAP_BATCH`.


## Cloudflare / Internet edge note
- If you use Cloudflare proxy and see **522**, the edge cannot reach your origin on 80/443. Ensure host firewall allows inbound TCP 80/443, router forwards 80/443 to this host, and Cloudflare SSL mode is **Full (strict)** once certs are issued.
- Cloudflare **Full** / **Full (strict)** require origin HTTPS on 443 with a certificate; **Flexible** uses HTTP to origin. If issuance fails while proxied, temporarily switch DNS record to DNS-only, issue certs, then re-enable proxy with **Full (strict)**.

## AI bot (notification-gated normal user)

The AI bot runs as a separate service (`bot/`) and authenticates like a regular Grishcord user account.

### Hard trigger gate behavior
- The bot listens to WebSocket `notification` events only.
- In server channels (`mode=channel`), it reacts only to ping/reply-style notifications.
- In DMs (`mode=dm`), it treats incoming DM notifications as valid triggers and replies in that DM.
- It does **not** scan raw message firehose events for triggers.

### Configure Ollama on the host VM
Use:
- `./scripts/aibotctl.sh ollama install`
- `./scripts/aibotctl.sh ollama update`
- `./scripts/aibotctl.sh ollama start`
- `./scripts/aibotctl.sh ollama stop`

You can still use the legacy top-level aliases (`install|update|start|stop`) for compatibility.

`install` and `update` use:
- `curl -fsSL https://ollama.com/install.sh | sh`

`install` writes host-local Ollama settings to `.ollama.env` (model path, model name, and resolved secure endpoint), configures the systemd override, and binds Ollama to a Docker-bridge-only host address that local containers can reach without exposing port `11434` on public/LAN interfaces. If Ollama is already installed, `aibotctl` checks the installed version against the latest release before downloading again.
When `HOST_DATA_ROOT` is set by the main installer, `aibotctl` defaults Ollama models to `${HOST_DATA_ROOT}/models` and will reuse already-installed models instead of blindly pulling again.

### Ollama secure endpoint
Grishcord now supports one Ollama networking path:

- Ollama binds to a secure host-local Docker bridge address on port `11434`.
- The Dockerized bot reads `OLLAMA_BASE_URL` from `.ollama.env`.
- The installer and `aibotctl` keep `.ollama.env` and runtime config synchronized automatically.
- Old `host.docker.internal`, `0.0.0.0:11434`, and `OLLAMA_BIND_MODE` installs are normalized forward on rerun/update.

`aibotctl` now waits for the Ollama API to become ready before model pulls, reducing restart/pull race failures.
The bot also performs an Ollama preflight (`GET /api/tags`) at startup and before first generation, and logs actionable secure-endpoint guidance if unreachable.

### Configure bot identity/runtime defaults
Use:
- `./scripts/aibotctl.sh bot install`
- `./scripts/aibotctl.sh bot config`
- `./scripts/aibotctl.sh bot show`
- `./scripts/aibotctl.sh bot restart`

This writes `.aibot.env` (editable later) with:
- `BOT_USERNAME`
- `BOT_DISPLAY_NAME`
- `BOT_COLOR`
- `OLLAMA_MODEL`

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
- The bot sends Ollama one JSON snapshot of the current DM/channel window and expects plain-text reply text back.
- If a trigger replies to an older GrishBot message, that older bot message is promoted into `priority_context.replied_to_bot_message` so the model can weight it just below the trigger itself.
- No rebuild is required by default because compose mounts only `bot/prompts/` to `/config/bot/prompts/` for the bot container. Restart the bot service after edits if needed.
- Bot container mounts are intentionally minimal (`bot/prompts/`, `.aibot.env`, `.ollama.env`) and do not include the full repo tree.

### Bot env vars
Required:
- `GRISHCORD_BASE_URL` (default: `http://backend:3000`)
- `BOT_USERNAME`
- `BOT_PASSWORD`
- `OLLAMA_BASE_URL` (stored in `.ollama.env` by `aibotctl`)
- `OLLAMA_MODEL`

Optional:
- `BOT_OLLAMA_TIMEOUT_MS` (default `180000`)
- `BOT_MAX_REPLY_CHARS` (default `1800`)
- `BOT_CONTEXT_MAX_MESSAGES` (default `12`)
- `BOT_RATE_LIMIT_MS` (default `2000`)
- `BOT_MAX_CONCURRENCY_PER_CHANNEL` (default `1`)
- `BOT_PROMPT_FILE` (default `/config/bot/prompts/system.txt`)
- `BOT_ENABLE_DMS` (default `true`)
- `BOT_ENABLE_CHANNELS` (default `true`)
- `BOT_ALLOWED_CHANNEL_IDS` (optional comma-separated channel id allowlist)
- `BOT_REPLY_ON_ERROR` (default `false`; send a short fallback reply on timeout/error/empty output)
- The bot now waits silently for longer Ollama generations by default and logs request lifecycle details; it only sends fallback text when `BOT_REPLY_ON_ERROR=true`.
- On startup the bot preloads its configured Ollama model and sends `keep_alive: -1` on bot-owned requests so that model stays resident when Ollama remains healthy.

### Manual verification checklist (acceptance)
1. Start Grishcord + bot (`./scripts/grishcordctl.sh start`) and confirm bot logs show successful login and WebSocket connection.
2. In a server text channel, send a normal message with no mention/reply: bot should **not** respond.
3. Ping `@<bot_username>` in a server channel: bot should respond as a **reply** to that message.
4. Reply to the bot’s message in a server channel: bot should respond.
5. Send a DM to the bot account: bot should respond in that DM.
6. Confirm no fallback reply is sent when `BOT_REPLY_ON_ERROR=false` by forcing a model timeout/error.

## Root admin protection
- The installer sets `ADMIN_USERNAME` in `.env` to the chosen root admin username.
- Backend stores the owner as `users.is_root_admin=true`; `ADMIN_USERNAME` is bootstrap/backfill config only.
- Backend enforces this root admin as non-demotable/non-deletable through admin APIs.
- Other admins cannot revoke root-admin authority server-side.
