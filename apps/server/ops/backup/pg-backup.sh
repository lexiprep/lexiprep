#!/bin/bash
# Daily Postgres backup -> gzip -> Cloudflare R2. Adapted from clara's mysql-backup.sh
# (pg_dump instead of mysqldump). Pings healthchecks.io (if configured) only after
# verifying the remote upload; a failure pings /fail immediately.
#
# Filename:  <db>_YYYY-MM-DD.sql.gz  (date only — same-day re-runs overwrite).
# R2 layout: <bucket>/<prefix>/<host>/<daily|monthly>/<file>
#            (1st of the month → monthly/ tier, kept for longer retention)

set -euo pipefail

# Required env (present via docker-compose for `make backup`; sourced from cron.env
# for the scheduled run — see entrypoint.sh).
: "${PGHOST:?required}"
: "${PGUSER:?required}"
: "${PGPASSWORD:?required}"
: "${PGDATABASE:?required}"
: "${BACKUP_R2_REMOTE:?required}"
: "${BACKUP_R2_BUCKET:?required}"
: "${BACKUP_MIN_SIZE:?required}"
: "${BACKUP_HOSTNAME:?required}"

export PGPORT="${PGPORT:-5432}"
R2_PREFIX="${BACKUP_R2_PREFIX:-db-backups}"
HC_URL="${BACKUP_HC_URL:-}"

HOST="$BACKUP_HOSTNAME"
DATE=$(date +%Y-%m-%d)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$(date +%d)" = "01" ]; then
  TIER="monthly"
else
  TIER="daily"
fi

REMOTE_DIR="${BACKUP_R2_REMOTE}:${BACKUP_R2_BUCKET}/${R2_PREFIX}/${HOST}/${TIER}"

fail() {
  local msg="$1"
  echo "FAIL: $msg" >&2
  if [ -n "$HC_URL" ]; then
    curl -fsS --retry 3 --max-time 10 --data-raw "$msg" "${HC_URL}/fail" > /dev/null || true
  fi
  exit 1
}

OUT="$TMPDIR/${PGDATABASE}_${DATE}.sql.gz"
# --clean --if-exists makes the dump idempotent on restore; --no-owner/--no-acl so it
# restores cleanly as whatever role runs psql. pipefail makes a pg_dump failure abort.
if ! pg_dump --no-owner --no-acl --clean --if-exists | gzip > "$OUT"; then
  fail "pg_dump failed for database: $PGDATABASE (host=$PGHOST)"
fi

SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt "$BACKUP_MIN_SIZE" ]; then
  fail "Dump suspiciously small: $SIZE bytes (min=$BACKUP_MIN_SIZE)"
fi

# rclone copy overwrites same-named objects — exactly right for date-only filenames
# (same-day re-runs replace today's file in place).
if ! rclone copy "$TMPDIR" "$REMOTE_DIR/" --quiet; then
  fail "rclone copy to R2 failed (target=$REMOTE_DIR)"
fi

# Verify by reading back the size of the object we just uploaded.
REMOTE_FILE="${REMOTE_DIR}/${PGDATABASE}_${DATE}.sql.gz"
REMOTE_BYTES=$(rclone size "$REMOTE_FILE" --json 2>/dev/null | jq -r '.bytes // 0')
if [ -z "$REMOTE_BYTES" ] || [ "$REMOTE_BYTES" -lt "$BACKUP_MIN_SIZE" ]; then
  fail "Remote verification failed: bytes at $REMOTE_FILE = ${REMOTE_BYTES:-unknown}"
fi

SUMMARY="host=$HOST tier=$TIER date=$DATE db=$PGDATABASE size=$SIZE remote_bytes=$REMOTE_BYTES"
if [ -n "$HC_URL" ]; then
  curl -fsS --retry 3 --max-time 10 --data-raw "$SUMMARY" "$HC_URL" > /dev/null || true
fi

echo "OK: $SUMMARY"
