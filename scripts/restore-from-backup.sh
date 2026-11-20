#!/usr/bin/env bash
# Verify checksum, decrypt and restore a backup into an EMPTY database.
#   restore-from-backup.sh <file.dump.enc> <target-db-url>     (env: BACKUP_PASSPHRASE)
set -euo pipefail
: "${BACKUP_PASSPHRASE:?}"; f="$1"
if [ -f "$f.sha256" ]; then
  want="$(cut -d' ' -f1 "$f.sha256")"; got="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "REFUSING: checksum mismatch (file corrupted or tampered)" >&2; exit 2; }
  echo "checksum ok"
else echo "WARNING: no .sha256 next to the file; integrity not pre-checked" >&2; fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$f" | "${PG_BIN:+$PG_BIN/}pg_restore" --dbname="$2" --exit-on-error
echo "restore complete"
