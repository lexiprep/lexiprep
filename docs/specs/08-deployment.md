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
- **Source is bind-mounted** (`./` and the sibling `../lexiprep-core`), so `git pull` on the
  host updates the code; a deploy just rebuilds the linked core and restarts.
- **node_modules in named volumes** (`nm_root`, `nm_server`, `nm_web`, `nm_core`) — a deploy
  reuses them; `make install` is the only thing that runs `pnpm install`.
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

## Required secrets (`.env`)

`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` (≥32 random chars), `BETTER_AUTH_URL` and
`WEB_ORIGIN` (the public origin the browser uses — with the proxy that's the **web** URL).
Compose fails fast if `POSTGRES_PASSWORD` / `BETTER_AUTH_SECRET` are unset.

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
