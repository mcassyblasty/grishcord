# Grishcord Deployment

## Prerequisites
- Docker Engine + Docker Compose plugin.
- DNS records created (see `docs/NETWORKING.md`).
- Host directories:
  - `/mnt/grishcord/postgres`
  - `/mnt/grishcord/uploads`
  - `/mnt/grishcord/config`

## Environment
1. Copy `.env.example` to `.env` and set secrets.
2. Place config files:
   - `/mnt/grishcord/config/livekit.yaml` (start from `infra/livekit/livekit.yaml`)
   - `/mnt/grishcord/config/turnserver.conf` (start from `infra/coturn/turnserver.conf`)

## Run
```bash
docker compose --env-file .env up -d --build
```

## Data persistence
All persistent data is under `/mnt/grishcord` via bind mounts:
- Postgres: `/mnt/grishcord/postgres`
- Uploads: `/mnt/grishcord/uploads`
- Service configs: `/mnt/grishcord/config`

## Update
```bash
git pull
docker compose --env-file .env up -d --build
```

## Storage-full policy
A retention sweeper runs automatically (default every 2 minutes). If `/mnt/grishcord` exceeds 90% utilization, oldest messages are deleted first; attached image files are deleted with their message references.
