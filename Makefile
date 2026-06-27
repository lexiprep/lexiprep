# lexiprep app — dev tasks. Run `make` for help.
filter ?=

.DEFAULT_GOAL := help

up: ## Start the full stack (Postgres + server + web) in Docker
	docker compose up -d --build
	@echo "  web:    http://localhost:$${WEB_PORT:-5173}"
	@echo "  server: http://localhost:$${SERVER_PORT:-3000}/health"

down: ## Stop and remove the stack
	docker compose down

build: ## Build the Docker images
	docker compose build

logs: ## Tail container logs
	docker compose logs -f

test: ## Run all tests. Optional: make test filter=<name>
	pnpm -r run test $(if $(filter),-- -t "$(filter)",)

dict-update: ## Refresh the dictionary (Open English WordNet) — safe upsert, no downtime
	docker compose exec server pnpm db:definitions

# ── Production (self-host) ────────────────────────────────────────────────────
# Prod stack lives in docker-compose.prod.yml. Deps persist in volumes, so a deploy
# never reinstalls — run `make install` only when the lockfile changes.
PROD := docker compose -f docker-compose.prod.yml

install: ## [prod] Install/update node_modules into the persisted volumes (run when the lockfile changes)
	$(PROD) build
	$(PROD) run --rm --no-deps server pnpm install --frozen-lockfile

migrate: ## [prod] Sync schema (drizzle-kit push) then run data migrations (drizzle-kit migrate)
	$(PROD) run --rm server sh -c "pnpm db:push && pnpm db:migrate"

seed: ## [prod] Seed CEFR word levels (one-time; idempotent, re-run if the wordlist changes)
	$(PROD) run --rm server pnpm db:seed

deploy: ## [prod] CI/CD: git pull, rebuild images, swap with minimal downtime, then migrate
	git pull --ff-only
	$(PROD) build                              # build while the old containers keep serving
	$(PROD) up -d --force-recreate server web backup  # quick swap (web waits for server healthy)
	$(MAKE) migrate
	@echo "Deployed → http://localhost:$${WEB_PORT:-5173}"

prod-up: ## [prod] Start the production stack
	$(PROD) up -d

prod-down: ## [prod] Stop the production stack
	$(PROD) down

prod-logs: ## [prod] Tail production logs
	$(PROD) logs -f

prod-dict: ## [prod] Refresh the dictionary in production (safe upsert)
	$(PROD) exec server pnpm db:definitions

backup: ## [prod] Run a DB backup to R2 right now (the sidecar also runs it on schedule)
	$(PROD) exec backup /backup/pg-backup.sh

backup-logs: ## [prod] Tail the backup log
	$(PROD) exec backup sh -c "touch /var/log/pg-backup.log && tail -n 200 -f /var/log/pg-backup.log"

help: ## Show available commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: up down build logs test dict-update install migrate seed deploy prod-up prod-down prod-logs prod-dict backup backup-logs help
