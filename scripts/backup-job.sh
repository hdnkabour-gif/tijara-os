#!/usr/bin/env bash
# Encrypted logical backup. Runs as a scheduled job (see Dockerfile.backup), NOT inside the app image.
#   BACKUP_DATABASE_URL  connection with a dedicated backup role (BYPASSRLS/superuser, read-only use)
#   BACKUP_PASSPHRASE    encryption passphrase (store it somewhere other than the backups!)
#   BACKUP_DEST          s3://bucket/prefix   (needs S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)  or  file:/dir
set -euo pipefail
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_PASSPHRASE:?}" "${BACKUP_DEST:?}"
[ "${#BACKUP_PASSPHRASE}" -ge 24 ] || { echo "BACKUP_PASSPHRASE must be >= 24 chars" >&2; exit 1; }
name="tijara-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
dump() { pg_dump --dbname="$BACKUP_DATABASE_URL" -Fc | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }
case "$BACKUP_DEST" in
  file:*) d="${BACKUP_DEST#file:}"; mkdir -p "$d"; dump > "$d/$name"; echo "backup written: $d/$name ($(stat -c %s "$d/$name") bytes)";;
  s3://*) dump | aws s3 cp - "$BACKUP_DEST/$name" --endpoint-url "${S3_ENDPOINT:?}"; echo "backup uploaded: $BACKUP_DEST/$name";;
  *) echo "unsupported BACKUP_DEST" >&2; exit 1;;
esac
