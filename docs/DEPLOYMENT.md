# Grishcord Deployment

## Prerequisites
- Debian host with mounted persistent storage at `/mnt/grishcord`.
- User `grishcord` with sudo privileges.

## Fastest reliable path
From repository root:
```bash
./scripts/fix_everything.sh
```
This script installs missing prerequisites, validates `/mnt/grishcord` mount, creates required subdirectories, and starts the stack with deterministic compose naming (`-p grishcord`).

## Normal start
```bash
./scripts/run_grishcord.sh
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
./scripts/fix_everything.sh
```

## Storage-full policy
A retention sweeper runs automatically (default every 2 minutes). If `/mnt/grishcord` exceeds 90% utilization, oldest messages are deleted first; attached image files are deleted with their message references.


## Version tracking
- Canonical version: `VERSION`
- Release history: `docs/CHANGELOG.md`
- Runtime version check (after startup): `curl -s http://<vm-ip>:<port>/api/version`
