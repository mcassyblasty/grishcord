# Grishcord Deployment

## Prerequisites
- Debian host with mounted persistent storage at `/mnt/grishcord`.
- User `grishcord` with sudo privileges.

## Fastest reliable path
From repository root:
```bash
./scripts/grishcordctl.sh start
```
This command starts the stack using deterministic compose naming (`-p grishcord`) with verbose progress and readiness timers. Ensure Docker/Compose and `/mnt/grishcord` are already set up.

## Normal start
```bash
./scripts/grishcordctl.sh start
```

## Manual compose commands (deterministic naming)
```bash
docker compose -p grishcord -f docker-compose.yml up -d --build
docker compose -p grishcord -f docker-compose.yml ps
```

## Data persistence
All persistent data is under `/mnt/grishcord` via bind mounts:
- Postgres: `/mnt/grishcord/postgres`
- Uploads: `/mnt/grishcord/uploads`
- Service configs: `/mnt/grishcord/config`

## Update
```bash
# after replacing repository files with a new release
./scripts/grishcordctl.sh update-start
```

## Storage-full policy
A retention sweeper runs automatically (default every 2 minutes). If `/mnt/grishcord` exceeds 90% utilization, oldest messages are deleted first; attached image files are deleted with their message references.


## Version tracking
- Canonical version: `VERSION` (single source of truth)
- Release history: `docs/CHANGELOG.md`
- `APP_VERSION` is optional override; if omitted, backend reads `/app/VERSION` automatically.
- Runtime version check (after startup): `curl -s http://localhost:<port>/api/version`
