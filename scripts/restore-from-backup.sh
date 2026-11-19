#!/usr/bin/env bash
# Decrypt a backup file and restore it into an (empty) database. Use for drills and disaster recovery.
#   restore-from-backup.sh <file.dump.enc> <target-db-url>      (env: BACKUP_PASSPHRASE)
set -euo pipefail
: "${BACKUP_PASSPHRASE:?}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$1" | pg_restore --dbname="$2" --exit-on-error 2>&1 | tail -5
