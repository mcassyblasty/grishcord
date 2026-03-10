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
- Grishcord repo location, DB data root, and repo source (git/wget/curl/local-archive)
- If `git` source: git URL
- Public hostname (used for `CADDY_SITE_ADDRESS`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`)
- Postgres password (or blank to keep/generate securely)
- Existing DB/admin is detected automatically from DB state (no manual yes/no prompt)
- Installer fails clearly when a DB path is present but unusable/corrupt or not a valid Grishcord schema
- Existing installs: installer prompts for detected admin password and verifies against stored DB hash before continuing (wrong password retries)
- Fresh installs: installer prompts for new admin username/display name/password
- Optional AI enablement (Ollama + bot account)
- If AI enabled: bot username/display name/password/color, plus Ollama install/config prompts
- If UFW is active and AI enabled: whether to apply Docker-subnet-to-Ollama allow rules

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
- `./scripts/grishcordctl.sh status` (compose status + LAN URL)
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

`install` writes host-local Ollama settings to `.ollama.env` (model path and model name), configures systemd override, and keeps Ollama bound to `127.0.0.1:11434`.


### Ollama networking modes (secure vs docker)
`./scripts/aibotctl.sh` supports two bind modes and persists your choice in `.ollama.env` (`OLLAMA_BIND_MODE`):

- **secure** (default): Ollama binds to `127.0.0.1:11434`.
  - Best default for host security.
  - A bot container cannot reach host-loopback through `host.docker.internal`.
  - Use this mode when the bot runs on the host network/process namespace (or outside Docker on the host).

- **docker**: Ollama binds to `0.0.0.0:11434`.
  - Needed for standard Docker bridge access from the bot container using `http://host.docker.internal:11434`.
  - Keep access restricted with host firewall/network policy so only local host + Docker networks can reach port `11434`.
  - Do **not** expose port `11434` to public networks.

The bot compose service is already configured with `extra_hosts: ["host.docker.internal:host-gateway"]` and defaults to `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

`aibotctl` now waits for the Ollama API to become ready before model pulls, reducing restart/pull race failures.
The bot also performs an Ollama preflight (`GET /api/tags`) at startup and before first generation, and logs actionable firewall guidance if unreachable.

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
- No rebuild is required by default because compose mounts only `bot/prompts/` to `/config/bot/prompts/` for the bot container. Restart the bot service after edits if needed.
- Bot container mounts are intentionally minimal (`bot/prompts/`, `.aibot.env`, `.ollama.env`) and do not include the full repo tree.

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
- `BOT_CONTEXT_MAX_MESSAGES` (default `10`)
- `BOT_RATE_LIMIT_MS` (default `2000`)
- `BOT_MAX_CONCURRENCY_PER_CHANNEL` (default `1`)
- `BOT_PROMPT_FILE` (default `/config/bot/prompts/system.txt`)
- `BOT_ENABLE_DMS` (default `true`)
- `BOT_ENABLE_CHANNELS` (default `true`)
- `BOT_ALLOWED_CHANNEL_IDS` (optional comma-separated channel id allowlist)
- `BOT_REPLY_ON_ERROR` (default `false`; send a short fallback reply on timeout/error/empty output)

### Manual verification checklist (acceptance)
1. Start Grishcord + bot (`./scripts/grishcordctl.sh start`) and confirm bot logs show successful login and WebSocket connection.
2. In a server text channel, send a normal message with no mention/reply: bot should **not** respond.
3. Ping `@<bot_username>` in a server channel: bot should respond as a **reply** to that message.
4. Reply to the bot’s message in a server channel: bot should respond.
5. Send a DM to the bot account: bot should respond in that DM.
6. Confirm no fallback reply is sent when `BOT_REPLY_ON_ERROR=false` by forcing a model timeout/error.

## Root admin protection
- The installer sets `ADMIN_USERNAME` in `.env` to the chosen root admin username.
- Backend enforces this root admin as non-demotable/non-deletable through admin APIs.
- Other admins cannot revoke root-admin authority server-side.
