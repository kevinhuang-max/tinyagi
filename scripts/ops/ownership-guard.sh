#!/bin/bash
# ownership-guard.sh — enforce that the TinyAGI install is owned by tinyagi:tinyagi.
#
# The whole /opt/tinyagi tree must be owned by the `tinyagi` service user. When a
# git op or file edit is accidentally run as root, files become root:root and the
# tinyagi-run daemon/agents can no longer read them (EACCES). That presents as a
# generic "encountered an error" outage but is really ownership drift, not a
# credential or data failure. This guard detects the drift, auto-corrects it, and
# logs an incident so the correction is visible instead of silent.
#
# Run as root (chown requires it). Idempotent; safe to run anytime or on a cron.
#   ownership-guard.sh [REPO]        (default REPO=/opt/tinyagi)
# Exit: 0 = clean or corrected; 1 = usage/precondition error.

set -uo pipefail
REPO="${1:-/opt/tinyagi}"
OWNER=tinyagi

[ "$(id -u)" -eq 0 ] || { echo "ownership-guard: must run as root (chown needs it)" >&2; exit 1; }
[ -d "$REPO" ]       || { echo "ownership-guard: $REPO not found" >&2; exit 1; }
id "$OWNER" >/dev/null 2>&1 || { echo "ownership-guard: user '$OWNER' does not exist" >&2; exit 1; }

INCIDENTS_BIN="$(command -v incidents 2>/dev/null || echo "$REPO/scripts/ops/incidents.sh")"

# Detect anything not owned by tinyagi. node_modules is excluded for speed (it is
# installed once as tinyagi and deploys never touch it as root). .git IS scanned:
# git run as root re-owns objects/refs and then blocks future tinyagi git ops.
# (while-read instead of mapfile so it runs on any bash, incl. macOS bash 3.2.)
BAD=()
while IFS= read -r _p; do [ -n "$_p" ] && BAD+=("$_p"); done < <(find "$REPO" -not -user "$OWNER" -not -path '*/node_modules/*' 2>/dev/null)

if [ "${#BAD[@]}" -eq 0 ]; then
  echo "ownership-guard: CLEAN — $REPO fully owned by $OWNER (node_modules excluded)"
  exit 0
fi

echo "ownership-guard: DRIFT — ${#BAD[@]} path(s) not owned by $OWNER:"
printf '  %s\n' "${BAD[@]:0:15}"
[ "${#BAD[@]}" -gt 15 ] && echo "  ... and $(( ${#BAD[@]} - 15 )) more"

chown "$OWNER:$OWNER" "${BAD[@]}"
echo "ownership-guard: corrected ${#BAD[@]} path(s) to $OWNER:$OWNER"

# Log the correction (write the ledger AS tinyagi so the db stays tinyagi-owned).
sudo -u "$OWNER" bash "$INCIDENTS_BIN" log --op ownership-guard --target "$REPO" --kind file \
  --verdict FAILED --agent ownership-guard \
  --error "Found ${#BAD[@]} path(s) not owned by $OWNER (e.g. ${BAD[0]}); auto-corrected via chown. Cause: a git/file op ran as root instead of $OWNER." \
  >/dev/null 2>&1 || true
echo "ownership-guard: logged incident"
exit 0
