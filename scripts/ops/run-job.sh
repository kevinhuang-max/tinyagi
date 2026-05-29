#!/bin/bash
# run-job.sh — thin wrapper so cron jobs record their last-run + exit code.
#
# The health monitor reads these markers to decide whether a scheduled job ran,
# succeeded, and how recently. Without a marker it can only guess from a log
# file's mtime; with one it knows the real exit code and duration. This wrapper
# is intentionally tiny and side-effect-free apart from the marker write.
#
# Usage:
#   run-job.sh <jobname> -- <command...>
#
# Behaviour:
#   - records start time, runs the command, captures its exit code + duration.
#   - writes a marker JSON atomically (temp file + mv) to
#       /opt/tinyagi/workspace/assistant/logs/.jobrun-<jobname>.json
#       {"job":"<name>","last_run":"<ISO8601 UTC>","exit_code":N,"duration_sec":N}
#   - exits with the command's own exit code (so cron / callers see it too).
#
# Portable: set -uo pipefail (NOT -e — we must survive a non-zero command to
# still write the marker), no bashisms that would break under dash.

set -uo pipefail

LOG_DIR="${TINYAGI_LOG_DIR:-/opt/tinyagi/workspace/assistant/logs}"

usage() {
  echo "usage: run-job.sh <jobname> -- <command...>" >&2
  exit 64
}

JOB="${1:-}"
[ -n "$JOB" ] || usage
shift

# Require the explicit '--' separator so the jobname can never be confused with
# part of the command.
SEP="${1:-}"
[ "$SEP" = "--" ] || usage
shift

[ "$#" -ge 1 ] || usage

# ISO8601 UTC. Prefer GNU/BSD date -u; both accept these flags.
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

START_EPOCH="$(date -u +%s)"

# Run the command. Do not let our own set -uo pipefail abort us on its failure.
"$@"
CODE=$?

END_EPOCH="$(date -u +%s)"
DURATION=$(( END_EPOCH - START_EPOCH ))
[ "$DURATION" -ge 0 ] || DURATION=0

# Write the marker atomically: a partial/truncated marker would mislead the
# monitor, so we write to a temp file in the same dir and mv into place.
mkdir -p "$LOG_DIR" 2>/dev/null || true
MARKER="$LOG_DIR/.jobrun-$JOB.json"
TMP="$MARKER.tmp.$$"

# Minimal JSON. Jobname is a cron-controlled identifier, not user input, but we
# still avoid embedding anything that needs escaping.
if printf '{"job":"%s","last_run":"%s","exit_code":%d,"duration_sec":%d}\n' \
      "$JOB" "$(now_iso)" "$CODE" "$DURATION" > "$TMP" 2>/dev/null; then
  mv -f "$TMP" "$MARKER" 2>/dev/null || rm -f "$TMP" 2>/dev/null || true
else
  rm -f "$TMP" 2>/dev/null || true
fi

exit "$CODE"
