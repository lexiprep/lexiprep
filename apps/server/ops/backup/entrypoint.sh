#!/bin/sh
# Backup sidecar entrypoint. Renders the rclone config from env, snapshots the env so
# the cron job can restore it (busybox crond runs jobs with a stripped environment),
# schedules the dump, and tails the log to stdout so `make backup-logs` / compose logs
# show runs. If R2 isn't configured, the sidecar stays idle instead of failing the
# whole prod stack — backups are opt-in via .env.
set -e

CONF_DIR=/root/.config/rclone
ENV_FILE=/backup/cron.env
LOG=/var/log/pg-backup.log

if [ -z "${BACKUP_R2_ACCESS_KEY_ID:-}" ] || [ -z "${BACKUP_R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${BACKUP_R2_ENDPOINT:-}" ]; then
  echo "[backup] R2 not configured (set BACKUP_R2_* in .env) — sidecar idle." >&2
  exec tail -f /dev/null
fi

mkdir -p "$CONF_DIR"
envsubst < /backup/rclone.conf.template > "$CONF_DIR/rclone.conf"
chmod 600 "$CONF_DIR/rclone.conf"

# Snapshot the runtime env for the cron job. Values are base64-encoded so secrets with
# any special characters survive sourcing intact (rclone's own creds live in the config
# file above, so they don't need to be here).
{
  echo "export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
  for var in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE \
             BACKUP_R2_REMOTE BACKUP_R2_BUCKET BACKUP_R2_PREFIX \
             BACKUP_MIN_SIZE BACKUP_HOSTNAME BACKUP_HC_URL; do
    eval "val=\${$var:-}"
    enc=$(printf '%s' "$val" | base64 | tr -d '\n')
    printf 'export %s="$(printf %%s %s | base64 -d)"\n' "$var" "$enc"
  done
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

CRON_EXPR="${BACKUP_CRON:-0 3 * * *}"
echo "$CRON_EXPR . $ENV_FILE; /backup/pg-backup.sh >> $LOG 2>&1" > /etc/crontabs/root
touch "$LOG"

echo "[backup] scheduled '$CRON_EXPR' → ${BACKUP_R2_REMOTE}:${BACKUP_R2_BUCKET}/${BACKUP_R2_PREFIX:-db-backups}/${BACKUP_HOSTNAME}" >&2
tail -F "$LOG" &
exec crond -f -l 8
