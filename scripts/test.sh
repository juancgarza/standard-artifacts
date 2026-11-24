#!/usr/bin/env bash
# End-to-end tests against a running app. Starts `alchemy dev` (local workerd + Vite,
# no cloud account) if nothing answers at STDARTIFACTS_URL, and stops it afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${STDARTIFACTS_URL:-http://localhost:5173}"
up() { curl -sf -o /dev/null "$URL/api/v1/workspace"; }

pnpm --filter stdartifacts build
pnpm --filter @standard-artifacts/desktop build

# `stdartifacts serve`: the packaged server on its own free port and temp data dir.
pnpm --filter @standard-artifacts/server build
pnpm --filter @standard-artifacts/server test

started=""
if ! up; then
  echo "Starting the app (alchemy dev)…"
  (cd apps/app && exec pnpm exec alchemy dev) > .test-app.log 2>&1 &
  started=$!
  trap '[ -n "$started" ] && kill "$started" 2>/dev/null || true' EXIT
  for _ in $(seq 1 180); do up && break; sleep 1; done
  if ! up; then
    echo "The app did not start; last log lines:"
    tail -60 .test-app.log
    exit 1
  fi
fi

STDARTIFACTS_URL="$URL" pnpm --filter @standard-artifacts/e2e test
