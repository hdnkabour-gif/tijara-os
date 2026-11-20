#!/usr/bin/env bash
# Reads backup file names (tijara-YYYYMMDDTHHMMSSZ.dump.enc) on stdin, prints the ones to DELETE.
# Keep: everything newer than KEEP_DAILY_DAYS; the newest per ISO week for KEEP_WEEKS weeks; the newest per month for KEEP_MONTHS months;
# and always the newest 3 files. NOW (epoch seconds) can be overridden for tests.
set -euo pipefail
DAILY="${KEEP_DAILY_DAYS:-7}"; WEEKS="${KEEP_WEEKS:-5}"; MONTHS="${KEEP_MONTHS:-12}"; NOW="${NOW:-$(date -u +%s)}"
mapfile -t names < <(sort -r)
declare -A seen_week seen_month; i=0
for n in "${names[@]}"; do
  i=$((i+1)); ts="${n#tijara-}"; ts="${ts%%.*}"
  epoch=$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}" +%s)
  age_days=$(( (NOW - epoch) / 86400 )); keep=0
  [ "$i" -le 3 ] && keep=1
  [ "$age_days" -lt "$DAILY" ] && keep=1
  wk="$(date -u -d "@$epoch" +%G-W%V)"; mo="$(date -u -d "@$epoch" +%Y-%m)"
  if [ "$age_days" -lt $((WEEKS*7)) ] && [ -z "${seen_week[$wk]:-}" ]; then seen_week[$wk]=1; keep=1; fi
  if [ "$age_days" -lt $((MONTHS*31)) ] && [ -z "${seen_month[$mo]:-}" ]; then seen_month[$mo]=1; keep=1; fi
  [ "$keep" -eq 1 ] || echo "$n"
done
