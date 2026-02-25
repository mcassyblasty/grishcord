# Grishcord

Minimal private Discord-like web app scaffold with Docker Compose, Postgres, LiveKit, and coturn.

## Install helper
- `./install_grishcord.sh` (interactive installer usable from anywhere: choose git/wget/curl and target directory)
- If `git` is selected and identity is not configured, the installer guides setup for `git config --global user.name` and `user.email`.

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
- `CORS_ORIGINS` should be a comma-separated allowlist of trusted frontend origins permitted to call the API with credentials.
- Authentication and recovery endpoints are rate-limited server-side; repeated failures receive HTTP `429` with `Retry-After`.

## Compose database host note
- In Docker Compose, `DATABASE_URL` must target the service hostname `postgres` (not `localhost` / `127.0.0.1`).


## Upload limits
- Supports image attachments and `.zip` attachments.
- Default backend upload cap is 100MB via `MAX_UPLOAD_BYTES` in `.env`.
