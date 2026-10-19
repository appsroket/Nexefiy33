#!/usr/bin/env bash
# Applies every migration to a throwaway local PostgreSQL cluster (with the
# Supabase stand-in in supabase/local/supabase-shim.sql), runs the pgTAP suite
# with pg_prove, then the database integration tests (tests/integration: the
# real runner, executor and SQL together). Nothing touches a hosted project.
#
# Needs PostgreSQL 16+ server binaries with the pgvector, pgTAP and plpython3u
# packages, Python's jsonschema module, and pg_prove. On Ubuntu:
#   apt-get install postgresql-16 postgresql-16-pgvector postgresql-16-pgtap \
#     postgresql-plpython3-16 python3-jsonschema libtap-parser-sourcehandler-pgtap-perl
#
# Usage: npm run db:test:local [-- pgtap-file-pattern]
#   LOCAL_DB_TESTS=pgtap|integration|all (default all)
# A pass is evidence about our SQL on plain PostgreSQL, not about Supabase.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${LOCAL_PG_PORT:-54329}"
PATTERN="${1:-}"
DATA="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$DATA"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() {
  if [ -n "${KEEP_LOCAL_DB:-}" ]; then
    echo "Left running: psql -h $DATA -p $PORT -U postgres"
    return
  fi
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA/db" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

# The pg_jsonschema stand-in has to sit in the server's extension directory.
EXT_DIR="$("$PG_BIN/pg_config" --sharedir)/extension"
if ! cmp -s "$ROOT/supabase/local/pg_jsonschema--0.0.1.sql" "$EXT_DIR/pg_jsonschema--0.0.1.sql" \
  || ! cmp -s "$ROOT/supabase/local/pg_jsonschema.control" "$EXT_DIR/pg_jsonschema.control"; then
  cp "$ROOT/supabase/local/pg_jsonschema.control" "$ROOT/supabase/local/pg_jsonschema--0.0.1.sql" "$EXT_DIR/" || {
    echo "Copy supabase/local/pg_jsonschema* into $EXT_DIR (needs write access)." >&2
    exit 1
  }
fi

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA/db" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA/db" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null

DB=nexefiy
psql -h "$DATA" -p "$PORT" -U postgres -d postgres -q -X -c "create database $DB" >/dev/null
PSQL=(psql -h "$DATA" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f "$ROOT/supabase/local/supabase-shim.sql" >/dev/null
# hnsw.iterative_scan needs pgvector 0.8 (Supabase has it); older local
# builds reject the setting, so it is dropped locally and reported.
VECTOR_VERSION="$("${PSQL[@]}" -tAc "select default_version from pg_available_extensions where name = 'vector'")"
STRIP='^$'
if [ "$(printf '%s\n0.8.0\n' "$VECTOR_VERSION" | sort -V | head -1)" != "0.8.0" ]; then
  echo "pgvector $VECTOR_VERSION locally: ignoring 'set hnsw.iterative_scan' (needs 0.8)."
  STRIP='^set hnsw\.iterative_scan'
fi
for migration in "$ROOT"/supabase/migrations/*.sql; do
  if ! grep -v "$STRIP" "$migration" | "${PSQL[@]}" -f - >"$DATA/migration.out" 2>&1; then
    echo "Migration failed: $(basename "$migration")" >&2
    cat "$DATA/migration.out" >&2
    exit 1
  fi
done
echo "Applied $(ls "$ROOT"/supabase/migrations/*.sql | wc -l) migrations to local PostgreSQL $("${PSQL[@]}" -tAc 'show server_version')."

WHICH="${LOCAL_DB_TESTS:-all}"
STATUS=0
if [ "$WHICH" != "integration" ]; then
  TESTS=("$ROOT"/supabase/tests/database/*${PATTERN}*.test.sql)
  PGHOST="$DATA" PGPORT="$PORT" PGUSER=postgres PGDATABASE="$DB" pg_prove --ext .sql "${TESTS[@]}" || STATUS=$?
fi
if [ "$WHICH" != "pgtap" ]; then
  # Each test file clones the migrated database, so no connection may stay open on it.
  (cd "$ROOT" && LOCAL_PG_HOST="$DATA" LOCAL_PG_PORT="$PORT" LOCAL_PG_TEMPLATE="$DB" \
    npx vitest run --config vitest.integration.config.ts) || STATUS=$?
fi
exit $STATUS
