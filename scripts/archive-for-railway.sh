#!/usr/bin/env bash
# Build the upload tarball from the committed tree (no node_modules/secrets) and stamp the exact commit into VERSION.
# Usage: scripts/archive-for-railway.sh out.tgz     (refuses to run with uncommitted changes)
set -euo pipefail
[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes: commit first so the stamped SHA is truthful" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git archive --format=tar -o "$tmp/src.tar" HEAD
git rev-parse HEAD > "$tmp/VERSION"
tar -rf "$tmp/src.tar" -C "$tmp" VERSION
gzip -c "$tmp/src.tar" > "$1"; echo "archive ok: $1 @ $(git rev-parse --short HEAD)"
