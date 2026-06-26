# 08 — Production deployment (self-host)

Status: **Implemented.** For internal / small-group self-hosting (a family, a few friends).
Not a managed multi-region setup — that's a later concern; the architecture doesn't preclude it.

## Goals

- **One-command CI/CD**: `make deploy` = `git pull` → rebuild → swap → migrate.
- **Don't reinstall node_modules every deploy.** Deps live in persisted volumes; only
  `make install` repopulates them (run when the lockfile changes).
- **Minimal downtime**: build images while the old containers keep serving, then a quick swap.
- **Secrets out of the image**, supplied via `.env`.

## Shape

A dedicated **`docker-compose.prod.yml`** (separate from the dev `docker-compose.yml`):

- **prod image targets** (`apps/{server,web}/Dockerfile` → `prod`), `NODE_ENV=production`.
- **Single repo.** `@lexiprep/core` is a published **npm dependency** (`^0.1.0`), so prod only
  checks out this repo — no sibling `lexiprep-core` and no in-container core build.
- **Source is bind-mounted** (`./`), so `git pull` on the host updates the code; a deploy just
  restarts.
- **node_modules in named volumes** (`nm_root`, `nm_server`, `nm_web`) — a deploy reuses them;
  `make install` is the only thing that runs `pnpm install`.
- **Only the web port is published**; the API is reached through web's `/api` proxy
  (`vite preview` proxies `/api` + `/health` to `server:3000`, same single-origin as dev).
- **db** is internal (no published port), data in the `pgdata` volume, `restart: unless-stopped`.

## Commands (Makefile)

| `make …` | Does |
|---|---|
| `install` | `pnpm install --frozen-lockfile` into the deps volumes (app workspace + core). Run once, and whenever the lockfile changes. |
| `deploy` | `git pull --ff-only` → `build` (old keeps serving) → `up -d --force-recreate server web` (swap; web waits for server healthy) → `migrate`. |
| `migrate` | `drizzle-kit push` via a one-off container — applies schema changes. |
| `prod-up` / `prod-down` / `prod-logs` | Manage the stack. |
| `prod-dict` | Refresh the offline dictionary (safe upsert, no downtime). |
| `backup` / `backup-logs` | Run a DB backup now (also runs on schedule) / tail the backup log. |

## Required secrets (`.env`)

`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` (≥32 random chars), `BETTER_AUTH_URL` and
`WEB_ORIGIN` (the public origin the browser uses — with the proxy that's the **web** URL).
Compose fails fast if `POSTGRES_PASSWORD` / `BETTER_AUTH_SECRET` are unset.

## Backups → Cloudflare R2

A **`backup`** sidecar (`apps/server/ops/backup/`, adapted from clara's mechanism) dumps
Postgres to R2 on a schedule. Self-contained: a busybox-crond container runs `pg_dump →
gzip → rclone copy → read-back verify → healthchecks.io ping`.

- **Image**: `postgres:17-alpine` (so `pg_dump` matches the server) + `rclone jq gettext curl bash`.
- **Layout**: `<bucket>/<prefix>/<host>/<daily|monthly>/<db>_YYYY-MM-DD.sql.gz`. Date-only
  filenames → same-day re-runs overwrite; the **1st of the month** also lands in `monthly/`
  for longer retention. Default bucket `lexiprep`, prefix `db-backups` (so the bucket can hold
  other lexiprep data later).
- **Config** is `.env`-driven (`BACKUP_R2_*`, `BACKUP_CRON`, `BACKUP_MIN_SIZE`, `BACKUP_HOSTNAME`,
  optional `BACKUP_HC_URL`). The credentials reuse an existing R2 account. **Opt-in**: with the
  R2 keys unset the sidecar stays idle, so it never blocks the stack.
- **Safety**: a dump below `BACKUP_MIN_SIZE`, a failed upload, or a failed read-back all abort
  and ping `…/fail` immediately. `deploy` recreates `backup` alongside `server`/`web`.
- **Restore** (manual): `gunzip -c <db>_DATE.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U lexiprep -d lexiprep`.
  The dump is `--clean --if-exists`, so it drops-and-recreates objects idempotently.

Open: no automatic pruning of old `daily/` files yet (cheap at this scale — one small gzip
per day); add an rclone-delete retention step if it ever matters. `monthly/` is the long tail.

## Known trade-offs / open questions

- **Migrations = `drizzle-kit push`**, matching dev (no generated migration files yet). Fine
  for additive changes; a destructive change would prompt and should be applied by hand.
  Moving to generated migrations (`drizzle-kit generate` + `migrate`) is the eventual path.
- **"Minimal" not zero downtime.** `--force-recreate` stops-then-starts the server/web
  containers; the gap is the core build + boot (seconds). True zero-downtime (baked images
  behind a reverse proxy / rolling update) is a future option — the bind-mount + deps-volume
  design was chosen for simplicity and the "git pull updates code" mental model.
- **TLS / public exposure** is out of scope here — put a reverse proxy (Caddy/nginx) in front
  for HTTPS when exposing beyond localhost/LAN.
