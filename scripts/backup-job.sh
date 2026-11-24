#!/usr/bin/env bash
# Encrypted, verified logical backup with retention and failure alerts. Runs as its own scheduled job (see Dockerfile.backup).
#   BACKUP_DATABASE_URL  dedicated backup role (BYPASSRLS so pg_dump can read every tenant) - read-only use
#   BACKUP_PASSPHRASE    >= 24 chars; keep it somewhere OTHER than the backups
#   BACKUP_DEST          file:/dir   or   s3://bucket/prefix   (S3-compatible, e.g. Cloudflare R2; needs S3_ENDPOINT,
#                        AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION=auto)
#   ALERT_WEBHOOK_URL    optional; receives {"text": "..."} on failure (never contains secrets)
#   KEEP_DAILY_DAYS=7 KEEP_WEEKS=5 KEEP_MONTHS=12   retention
set -Eeuo pipefail
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_PASSPHRASE:?}" "${BACKUP_DEST:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

alert() {   # message only: no URLs with credentials, no passphrase
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"Tijara OS backup FAILED: $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
}
# Record the outcome in the database (platform_backup_events) so the Control Center shows what really happened.
# Values travel as psql variables (:'x'), never spliced into SQL. Best effort: a recording problem never hides the backup result.
DEST_KIND="${BACKUP_DEST%%:*}"
record() {   # record <true|false> <json detail>
  "${PG_BIN:+$PG_BIN/}psql" --dbname="$BACKUP_DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -v ok="$1" -v detail="$2" >/dev/null 2>&1 <<'SQL' || echo "warning: could not record the backup status" >&2
SELECT platform_record_backup('backup', :'ok'::boolean, :'detail'::jsonb);
SQL
}
fail() { echo "backup failed: $1" >&2; alert "$1"; record false "{\"dest\":\"$DEST_KIND\",\"error\":\"$(printf '%s' "$1" | tr -cd '[:alnum:] ._()-')\"}"; exit 1; }
trap 'fail "step failed near line $LINENO"' ERR
[ "${#BACKUP_PASSPHRASE}" -ge 24 ] || fail "BACKUP_PASSPHRASE shorter than 24 characters"

# ── storage adapter ──
S3=(aws s3); [ -n "${S3_ENDPOINT:-}" ] && S3=(aws s3 --endpoint-url "$S3_ENDPOINT")
case "$BACKUP_DEST" in
  file:*) D="${BACKUP_DEST#file:}"; mkdir -p "$D"
          put()  { cp "$1" "$D/$2"; };  get() { cp "$D/$1" "$2"; };  list() { ls -1 "$D" 2>/dev/null || true; };  del() { rm -f "$D/$1"; };;
  s3://*) put()  { "${S3[@]}" cp --only-show-errors "$1" "$BACKUP_DEST/$2"; }
          get()  { "${S3[@]}" cp --only-show-errors "$BACKUP_DEST/$1" "$2"; }
          list() { "${S3[@]}" ls "$BACKUP_DEST/" | awk '{print $4}'; }
          del()  { "${S3[@]}" rm --only-show-errors "$BACKUP_DEST/$1"; };;
  *) fail "unsupported BACKUP_DEST";;
esac

NAME="tijara-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
# 1) dump -> encrypt (AES-256-CBC, PBKDF2) -> checksum
"${PG_BIN:+$PG_BIN/}pg_dump" --dbname="$BACKUP_DATABASE_URL" -Fc | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE > "$WORK/$NAME"
SUM="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"; echo "$SUM  $NAME" > "$WORK/$NAME.sha256"
# 2) integrity BEFORE upload: it must decrypt and be a readable, non-empty archive
ITEMS="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$WORK/$NAME" | "${PG_BIN:+$PG_BIN/}pg_restore" --list | grep -c ' TABLE ' || true)"
[ "$ITEMS" -ge 10 ] || fail "archive looks empty or unreadable ($ITEMS tables)"
# 3) upload, then READ BACK and compare checksum (verify-after-write)
put "$WORK/$NAME" "$NAME"; put "$WORK/$NAME.sha256" "$NAME.sha256"
get "$NAME" "$WORK/readback"; [ "$(sha256sum "$WORK/readback" | cut -d' ' -f1)" = "$SUM" ] || fail "read-back checksum mismatch after upload"
echo "backup ok: $NAME ($(stat -c %s "$WORK/$NAME") bytes, $ITEMS tables, sha256 ${SUM:0:12}…)"
record true "{\"dest\":\"$DEST_KIND\",\"name\":\"$NAME\",\"bytes\":$(stat -c %s "$WORK/$NAME"),\"tables\":$ITEMS}"
# 4) retention (never deletes the newest 3 backups)
list | grep -E '^tijara-[0-9]{8}T[0-9]{6}Z\.dump\.enc$' | "$HERE/retention.sh" | while read -r old; do del "$old"; del "$old.sha256"; echo "pruned: $old"; done
