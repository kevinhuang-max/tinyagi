#!/bin/bash
# incidents.sh — structured incident log for TinyAGI (Layer 1).
#
# A small, append-only SQLite ledger of real failures and unverified results.
# Agents and the connector-check helper write facts here instead of asserting
# "X is broken" in chat. Kevin and other agents read this ledger directly over
# SSH instead of re-litigating from a transcript.
#
# DB location is overridable for testing:
#   INCIDENTS_DB=/tmp/test-incidents.db ./incidents.sh init
# Default on the production box: /home/tinyagi/.claude/incidents.db (owned by
# the tinyagi user, same dir as mira-memory.db so agents can write to it).
#
# Subcommands:
#   init                 create the schema (idempotent)
#   log   <flags>        record one incident (see flags below)
#   list  [N]            show the last N incidents (default 20)
#   stats                counts by verdict
#
# log flags:
#   --op <op>            operation attempted (e.g. confluence-search)   [required]
#   --verdict <v>        OK | FAILED | UNVERIFIED                       [required]
#   --target <t>         endpoint / file / resource probed
#   --kind <k>           connector | file | data | other  (default: other)
#   --http <code>        HTTP status code, if an HTTP probe
#   --size <bytes>       file size in bytes, if a file probe
#   --error "<raw>"      raw error text / probe output (truncated to 2000 chars)
#   --agent <id>         who logged it (default: $AGENT_ID or "cli")

set -euo pipefail

DB="${INCIDENTS_DB:-/home/tinyagi/.claude/incidents.db}"

die() { echo "incidents: $*" >&2; exit 64; }
need_sqlite() { command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found in PATH"; }
sqlesc() { printf '%s' "${1:-}" | sed "s/'/''/g"; }  # double single-quotes for SQL literals

init_schema() {
  need_sqlite
  mkdir -p "$(dirname "$DB")" 2>/dev/null || true
  sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  agent       TEXT,
  op          TEXT,
  target      TEXT,
  kind        TEXT,
  http_status INTEGER,
  file_size   INTEGER,
  verdict     TEXT NOT NULL,
  raw_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_ts      ON incidents(ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_verdict ON incidents(verdict);
SQL
}

cmd_log() {
  need_sqlite
  local op="" verdict="" target="" kind="other" http="" size="" err="" agent="${AGENT_ID:-cli}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --op)      op="$2"; shift 2 ;;
      --verdict) verdict="$2"; shift 2 ;;
      --target)  target="$2"; shift 2 ;;
      --kind)    kind="$2"; shift 2 ;;
      --http)    http="$2"; shift 2 ;;
      --size)    size="$2"; shift 2 ;;
      --error)   err="$2"; shift 2 ;;
      --agent)   agent="$2"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [ -n "$op" ]      || die "log requires --op"
  [ -n "$verdict" ] || die "log requires --verdict"
  case "$verdict" in OK|FAILED|UNVERIFIED) ;; *) die "verdict must be OK|FAILED|UNVERIFIED" ;; esac
  err="${err:0:2000}"

  # Build column/value lists, omitting nullable numerics when empty.
  local cols="agent, op, target, kind, verdict, raw_error"
  local vals="'$(sqlesc "$agent")', '$(sqlesc "$op")', '$(sqlesc "$target")', '$(sqlesc "$kind")', '$(sqlesc "$verdict")', '$(sqlesc "$err")'"
  if [ -n "$http" ]; then cols="$cols, http_status"; vals="$vals, $((http))"; fi
  if [ -n "$size" ]; then cols="$cols, file_size";   vals="$vals, $((size))"; fi

  init_schema
  # INSERT and last_insert_rowid() must share one connection, else the id reads 0.
  local id; id=$(sqlite3 "$DB" "INSERT INTO incidents ($cols) VALUES ($vals); SELECT last_insert_rowid();")
  echo "logged incident #$id ($verdict $kind $op)"
}

cmd_list() {
  need_sqlite
  [ -f "$DB" ] || { echo "(no incidents db yet at $DB)"; return 0; }
  local n="${1:-20}"
  sqlite3 "$DB" "
SELECT '#' || id || '  ' || ts || '  ' || printf('%-10s', verdict) || '  ' ||
       printf('%-9s', COALESCE(kind,'-')) || '  ' || COALESCE(op,'-') ||
       '  [' || COALESCE(target,'-') || ']' ||
       CASE WHEN http_status IS NOT NULL THEN '  http=' || http_status ELSE '' END ||
       CASE WHEN file_size   IS NOT NULL THEN '  size=' || file_size   ELSE '' END ||
       CASE WHEN raw_error IS NOT NULL AND raw_error <> ''
            THEN char(10) || '     err: ' || substr(raw_error,1,140) ELSE '' END
FROM incidents ORDER BY id DESC LIMIT $((n));"
}

cmd_stats() {
  need_sqlite
  [ -f "$DB" ] || { echo "(no incidents db yet at $DB)"; return 0; }
  echo "incident counts by verdict:"
  sqlite3 "$DB" "SELECT '  ' || printf('%-10s', verdict) || ' ' || COUNT(*) FROM incidents GROUP BY verdict ORDER BY COUNT(*) DESC;"
  echo "total: $(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents;")  (db: $DB)"
}

case "${1:-}" in
  init)  init_schema; echo "incidents schema ready at $DB" ;;
  log)   shift; cmd_log "$@" ;;
  list)  shift; cmd_list "$@" ;;
  stats) cmd_stats ;;
  ""|-h|--help)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown command: $1 (try: init | log | list | stats)" ;;
esac
