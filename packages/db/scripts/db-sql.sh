#!/usr/bin/env bash
# Run SQL on the database in DATABASE_URL (the owner's connection string) and stop at the first error.
#   bash packages/db/scripts/db-sql.sh -f file.sql
#   bash packages/db/scripts/db-sql.sh -c "select 1"
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is not set}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
