#!/usr/bin/env bash
# Applies pending migrations to the Neon PREVIEW database (project purple-wind-75278769, branch main). Never production.
#   packages/db/scripts/neon-preview-migrate.sh --dry-run   # list what would be applied
#   packages/db/scripts/neon-preview-migrate.sh             # apply it
# The connection URI comes from the Neon API (the agent proxy injects the key), is held only in this process's
# environment, and is never printed or written to disk.
set -euo pipefail
case "${1:-}" in "" | --dry-run) ;; *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."
uri=$(curl -sSf "https://console.neon.tech/api/v2/projects/purple-wind-75278769/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false" \
  -H "Authorization: Bearer proxy-injected" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).uri))')
[ -n "$uri" ] || { echo "No connection URI from the Neon API" >&2; exit 1; }
DATABASE_URL="$uri" exec node --experimental-strip-types scripts/migrate.ts --driver neon-ws ${1:+"$1"}
