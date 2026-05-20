#!/bin/sh
# publish.sh — build the public shell + encrypt the content, then push.
#
#   ./publish/publish.sh
#
# 1. Runs build/build.py        -> docs/index.html (public shell) + build/seed.json
# 2. Encrypts build/seed.json   -> docs/data/snapshot.enc  (AES-256-CBC, PBKDF2 100k)
#    using the password in publish/.publish-password (== the Worker VIEWER_PASSWORD).
# 3. Writes docs/data/snapshot.meta.json (public, no secrets).
# 4. Commits docs/ and pushes.
#
# The browser + the Cloudflare Worker decrypt with the exact same parameters.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASSWORD_FILE="$ROOT/publish/.publish-password"
SEED_JSON="$ROOT/build/seed.json"
SNAPSHOT_OUT="$ROOT/docs/data/snapshot.enc"
META_OUT="$ROOT/docs/data/snapshot.meta.json"

if [ ! -f "$PASSWORD_FILE" ]; then
  echo "[publish] ERROR: $PASSWORD_FILE not found." >&2
  echo "          Create it (this must equal the Worker VIEWER_PASSWORD secret):" >&2
  echo "              printf 'your-viewer-password' > publish/.publish-password" >&2
  echo "              chmod 600 publish/.publish-password" >&2
  exit 1
fi
PASSWORD="$(cat "$PASSWORD_FILE")"
[ -z "$PASSWORD" ] && { echo "[publish] ERROR: password file is empty." >&2; exit 1; }

echo "[publish] Building shell + seed …"
python3 "$ROOT/build/build.py"

[ -f "$SEED_JSON" ] || { echo "[publish] ERROR: build did not produce seed.json" >&2; exit 1; }

mkdir -p "$(dirname "$SNAPSHOT_OUT")"
echo "[publish] Encrypting content …"
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -salt -base64 -A \
  -pass pass:"$PASSWORD" \
  -in  "$SEED_JSON" \
  -out "$SNAPSHOT_OUT"

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SHA="$(shasum -a 256 "$SNAPSHOT_OUT" | awk '{print substr($1,1,12)}')"
SIZE="$(wc -c < "$SNAPSHOT_OUT" | tr -d ' ')"
cat > "$META_OUT" <<EOF
{
  "publishedAt": "$NOW",
  "snapshotSha256Prefix": "$SHA",
  "snapshotBytes": $SIZE
}
EOF
echo "[publish] Snapshot: $SNAPSHOT_OUT ($SIZE bytes, sha=$SHA)"

if [ ! -d "$ROOT/.git" ]; then
  echo "[publish] NOTE: not a git repo yet — skipping push."
  echo "          git init && git remote add origin <url> && re-run."
  exit 0
fi

git add docs/
if git diff --cached --quiet; then
  echo "[publish] No changes in docs/. Nothing to push."
  exit 0
fi
git commit -m "publish: $NOW (sha=$SHA)"
BR="$(git rev-parse --abbrev-ref HEAD)"
echo "[publish] Pushing to origin/$BR …"
git push origin "$BR"
echo "[publish] Done. GitHub Pages updates in ~30s."
