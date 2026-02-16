# Grishcord

Minimal private Discord-like web app scaffold with Docker Compose, Postgres, LiveKit, and coturn.

## Operations
- `./scripts/fix_everything.sh` (repair prerequisites + deterministic detached start)
- `./scripts/run_grishcord.sh` (deterministic detached start + LAN URL output)

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
