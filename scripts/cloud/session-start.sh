#!/usr/bin/env bash
# shellcheck disable=SC2329  # step functions are called through `step`
# SessionStart hook (.claude/settings.json). Installs dependencies in a Claude Code cloud
# session; a no-op everywhere else. Idempotent: session resume runs it again.
# Stdout lands in Claude's context, so it prints only the summary. Details go to $LOG.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG=/tmp/cloud-session-start.log
SUMMARY=""

note() { SUMMARY+="$1"$'\n'; }

# step <name> <cmd...>: run cmd with its output in $LOG and record ok / FAIL.
step() {
  local name=$1; shift
  echo "== $name ($(date -u +%FT%TZ))" >>"$LOG"
  if "$@" >>"$LOG" 2>&1; then note "$name: ok"; else note "$name: FAIL (see $LOG)"; return 1; fi
}

install_deps() ( cd "$REPO" && pnpm install --frozen-lockfile )

echo "==== session-start $(date -u +%FT%TZ) session=${CLAUDE_CODE_REMOTE_SESSION_ID:-?}" >>"$LOG"
if command -v pnpm >/dev/null 2>&1; then
  note "node $(node -v 2>/dev/null), pnpm $(pnpm -v 2>/dev/null)"
  step deps install_deps
else
  note "node $(node -v 2>/dev/null), pnpm: WARN missing (setup script not run?); deps skipped"
fi
command -v jq >/dev/null 2>&1 || note "jq: WARN missing; smoke surface shell will SKIP"
command -v gh >/dev/null 2>&1 || note "gh: WARN missing; smoke surface gh will SKIP"

printf 'cloud session-start (log %s)\n%s' "$LOG" "$SUMMARY"
printf 'Smoke check: bash scripts/cloud/smoke.sh\n'
exit 0
