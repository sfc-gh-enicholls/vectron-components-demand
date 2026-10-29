#!/bin/bash
# Build the read-only static copy and publish it to the public
# sfc-gh-enicholls/vectron-demand-demo repo, served by GitHub Pages.
# This source repo stays private; only the built HTML/JS/CSS and recorded data
# are pushed. Record fresh data first (needs `npm run dev` with live Snowflake):
#   python3 scripts/static/record-snapshot.py
# Then, from the app root:
#   bash scripts/static/publish-pages.sh            # build and publish
#   bash scripts/static/publish-pages.sh --no-push  # build only, into ./out
set -euo pipefail
REPO=vectron-demand-demo
ROOT=$(pwd)
[ -f "$ROOT/scripts/static/snapshot/index.json" ] || { echo "No snapshot: run record-snapshot.py first." >&2; exit 1; }

# Build from a throwaway copy without the server-only API route handlers, which a
# static export cannot include, and without .env files (no credentials in the
# build). The working tree and any running dev server are untouched.
BUILD=$(mktemp -d)
rsync -a --exclude node_modules --exclude .next --exclude out --exclude .git --exclude '.env*' "$ROOT/" "$BUILD/"
# Turbopack refuses a symlinked node_modules; an APFS clone (cp -c) is near-instant.
cp -Rc "$ROOT/node_modules" "$BUILD/node_modules"
find "$BUILD/src/app/api" -name 'route.ts' -delete
(cd "$BUILD" && STATIC_COPY=1 PAGES_REPO=$REPO npx next build)

rm -rf "$ROOT/out"
cp -R "$BUILD/out" "$ROOT/out"
rm -rf "$BUILD"
# Source maps would publish the private source in readable form.
find "$ROOT/out" -name '*.map' -delete
cp "$ROOT/scripts/static/static-api.js" "$ROOT/out/static-api.js"
cp -R "$ROOT/scripts/static/snapshot" "$ROOT/out/snapshot"
touch "$ROOT/out/.nojekyll"
printf '%s\n' "# Vectron Components demand planning demo (read-only copy)" "" \
  "Static build of a Snowflake demo with recorded data. Vectron Components is fictional and all figures are synthetic." \
  "Published from a private source repo; do not edit here." > "$ROOT/out/README.md"
echo "Built $ROOT/out"
[ "${1:-}" = "--no-push" ] && exit 0

TMP=$(mktemp -d)
cp -R "$ROOT/out/." "$TMP"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
cd "$TMP"
git init -q -b main
git add -A
git commit -q -m "Publish read-only copy from $SHA"
git push -q --force "git@github.com:sfc-gh-enicholls/$REPO.git" main
echo "Published to https://sfc-gh-enicholls.github.io/$REPO/"
