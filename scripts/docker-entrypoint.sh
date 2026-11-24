#!/bin/sh
# Starts as root ONLY to give the unprivileged "node" user the persistent media volume (Railway mounts volumes as root),
# then drops privileges for good: the application itself never runs as root.
set -eu
if [ -n "${MEDIA_DIR:-}" ]; then
  mkdir -p "$MEDIA_DIR"
  chown node:node "$MEDIA_DIR"
  chmod 700 "$MEDIA_DIR"
fi
exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- "$@"
