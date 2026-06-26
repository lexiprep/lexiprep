# Backup sidecar. Based on the same postgres image as the db service so pg_dump's
# version always matches the server (a newer client can dump an older server, but
# matching avoids surprises). Adds: bash (scripts), rclone (R2 upload), jq (parse
# rclone JSON), gettext (envsubst for rclone.conf), curl (healthchecks.io ping).
# crond, base64 and tail come from busybox in the base image.
FROM postgres:17-alpine

RUN apk add --no-cache bash rclone jq gettext curl

COPY . /backup/
RUN chmod +x /backup/pg-backup.sh /backup/entrypoint.sh

ENTRYPOINT ["/backup/entrypoint.sh"]
