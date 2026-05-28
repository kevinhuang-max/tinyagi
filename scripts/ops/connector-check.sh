#!/bin/bash
# connector-check.sh — live probe of an external connector (Layer 0).
#
# Runs a REAL request against a connector and reports a verdict based on the
# actual response, not a guess. This is the tool agents must use before saying
# "X is down / the token is revoked / the key is dead." A 2xx is proof it works.
#
# On a real failure it auto-logs an incident (via the sibling `incidents` helper)
# so the failure is recorded as a fact, not a chat claim.
#
# Usage:
#   connector-check <name>
#
# Supported names: confluence | slack | salesforce
#   (OAuth connectors like gmail/drive are not probed here — verify those with gws.)
#
# Exit codes:
#   0  OK         (2xx / ok:true) — no incident logged
#   1  FAILED     real failure — incident logged with the status code
#   2  UNVERIFIED could not run the probe (missing creds) — incident logged
#   3  usage error
#
# Credentials are read from the environment. On the production box a deploy step
# writes them to ${CHECK_CREDS_FILE:-/opt/tinyagi/.connector-creds} as KEY=VALUE
# lines; if that file exists it is sourced. Expected vars per connector:
#   confluence : CONFLUENCE_EMAIL, CONFLUENCE_TOKEN, CONFLUENCE_SITE
#   slack      : SLACK_BOT_TOKEN
#   salesforce : SUPABASE_URL, SUPABASE_ANON_KEY

set -uo pipefail

NAME="${1:-}"
AGENT="${AGENT_ID:-connector-check}"
CREDS_FILE="${CHECK_CREDS_FILE:-/opt/tinyagi/.connector-creds}"

# Locate the incidents logger: prefer one in PATH, else the sibling script.
INCIDENTS_BIN="$(command -v incidents 2>/dev/null || true)"
[ -n "$INCIDENTS_BIN" ] || INCIDENTS_BIN="$(cd "$(dirname "$0")" && pwd)/incidents.sh"

log_incident() {  # verdict op target http error
  local verdict="$1" op="$2" target="$3" http="$4" error="$5"
  local args=(log --op "$op" --target "$target" --kind connector --verdict "$verdict" --agent "$AGENT")
  [ -n "$http" ] && args+=(--http "$http")
  [ -n "$error" ] && args+=(--error "$error")
  if [ -x "$INCIDENTS_BIN" ] || [ -f "$INCIDENTS_BIN" ]; then
    bash "$INCIDENTS_BIN" "${args[@]}" >/dev/null 2>&1 || true
  fi
}

usage() { echo "usage: connector-check <confluence|slack|salesforce>" >&2; exit 3; }
[ -n "$NAME" ] || usage
command -v curl >/dev/null 2>&1 || { echo "connector-check: curl not found" >&2; exit 3; }

# Load creds file if present (KEY=VALUE lines).
# shellcheck disable=SC1090
[ -f "$CREDS_FILE" ] && . "$CREDS_FILE"

ok()   { echo "OK $NAME ${1:-}"; exit 0; }
fail() { echo "FAILED $NAME ${1:-}"; log_incident FAILED "${NAME}-check" "$2" "$3" "${4:-}"; exit 1; }
unver(){ echo "UNVERIFIED $NAME ${1:-}"; log_incident UNVERIFIED "${NAME}-check" "${2:-}" "" "${3:-}"; exit 2; }

case "$NAME" in
  confluence)
    : "${CONFLUENCE_SITE:=https://visitingmedia.atlassian.net}"
    [ -n "${CONFLUENCE_EMAIL:-}" ] && [ -n "${CONFLUENCE_TOKEN:-}" ] \
      || unver "missing CONFLUENCE_EMAIL/CONFLUENCE_TOKEN" "$CONFLUENCE_SITE" "no creds in env or $CREDS_FILE"
    # base64 must NOT wrap — Linux base64 wraps at 76 cols, which corrupts the header.
    auth=$(printf '%s' "${CONFLUENCE_EMAIL}:${CONFLUENCE_TOKEN}" | base64 | tr -d '\n')
    url="${CONFLUENCE_SITE}/wiki/rest/api/space?limit=1"
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
            -H "Authorization: Basic $auth" -H "Accept: application/json" "$url" 2>/dev/null) || code="000"
    case "$code" in
      2*) ok "http=$code" ;;
      000) fail "no response (network/timeout)" "$url" "$code" "curl could not reach host" ;;
      *)  fail "http=$code" "$url" "$code" "Confluence returned $code" ;;
    esac
    ;;

  slack)
    [ -n "${SLACK_BOT_TOKEN:-}" ] || unver "missing SLACK_BOT_TOKEN" "slack.com/api/auth.test" "no token in env or $CREDS_FILE"
    url="https://slack.com/api/auth.test"
    body=$(curl -sS --max-time 20 -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$url" 2>/dev/null) || body=""
    # Slack returns HTTP 200 even on auth failure; the truth is in "ok":true/false.
    if printf '%s' "$body" | grep -q '"ok":true'; then
      team=$(printf '%s' "$body" | sed -n 's/.*"team":"\([^"]*\)".*/\1/p')
      ok "ok:true team=${team:-?}"
    else
      reason=$(printf '%s' "$body" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
      fail "ok:false error=${reason:-unknown}" "$url" "" "auth.test returned ok:false: ${body:0:200}"
    fi
    ;;

  salesforce|supabase)
    [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ] \
      || unver "missing SUPABASE_URL/SUPABASE_ANON_KEY" "${SUPABASE_URL:-supabase}" "no creds in env or $CREDS_FILE"
    url="${SUPABASE_URL}/rest/v1/Account?select=Id&limit=1"
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
            -H "apikey: ${SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
            -H "Accept-Profile: salesforce" "$url" 2>/dev/null) || code="000"
    case "$code" in
      2*) ok "http=$code" ;;
      401|403) fail "http=$code (anon key likely rotated)" "$url" "$code" "Supabase returned $code — rotate/refresh anon key" ;;
      000) fail "no response (network/timeout)" "$url" "$code" "curl could not reach host" ;;
      *)  fail "http=$code" "$url" "$code" "Supabase returned $code" ;;
    esac
    ;;

  *) echo "connector-check: unknown connector '$NAME'" >&2; usage ;;
esac
