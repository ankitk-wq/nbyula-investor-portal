#!/bin/sh
# pull.sh — decrypt the live snapshot back to a readable JSON (recovery / inspect).
#
#   ./publish/pull.sh            # -> build/seed.from-live.json
#
# Uses the same password file as publish.sh.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASSWORD_FILE="$ROOT/publish/.publish-password"
SNAPSHOT="$ROOT/docs/data/snapshot.enc"
OUT="$ROOT/build/seed.from-live.json"

[ -f "$PASSWORD_FILE" ] || { echo "[pull] ERROR: $PASSWORD_FILE missing" >&2; exit 1; }
[ -f "$SNAPSHOT" ]      || { echo "[pull] ERROR: $SNAPSHOT missing" >&2; exit 1; }
PASSWORD="$(cat "$PASSWORD_FILE")"

openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -d -base64 -A \
  -pass pass:"$PASSWORD" \
  -in  "$SNAPSHOT" \
  -out "$OUT"
echo "[pull] Wrote $OUT"
