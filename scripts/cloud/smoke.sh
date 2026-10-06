#!/usr/bin/env bash
# shellcheck disable=SC2329
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SURFACES='
install|Install (frozen lockfile, strict peers)||pnpm install --frozen-lockfile --strict-peer-dependencies
lint|Biome (biome ci)|deps|pnpm biome ci
build|Build all packages|deps|pnpm build
typecheck|Typecheck all packages|build|pnpm typecheck
unit|Unit tests (pnpm -r test:run)|build|pnpm -r test:run
shell|Shell tests (test/*.test.sh)|jq|pnpm test:shell
gh|gh REST API lists PRs|gh|gh_check
'

NOT_RUNNABLE='
F1 test drives|They start real Claude sessions, which need an Anthropic credential. This shared environment has none, so this is expected. The F1 server also runs on Bun, which setup.sh does not install.
Live Claude SDK tests (CYRUS_LIVE_SDK_TEST=1)|Need an Anthropic credential. Without the flag, the unit surface skips them.
Docker image build (Dockerfile)|dockerd is not started, and no surface needs it. The shell surface still tests the docker helper scripts, which need no daemon.
Live Linear, GitHub, GitLab and Slack integrations|Need OAuth tokens and a public webhook endpoint. This environment holds no secrets.
'

need() {
  case "$1" in
    deps) [ -d "$REPO/node_modules/.bin" ] ;;
    jq) command -v jq >/dev/null 2>&1 ;;
    gh) command -v gh >/dev/null 2>&1 ;;
    *) [ "$(result_of "$1")" = PASS ] ;;
  esac
}

# REST only: cloud sessions block GitHub GraphQL (HTTP 403).
gh_check() {
  local repo n
  repo="$(git remote get-url origin | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')"
  echo "repo: $repo"
  n="$(gh api "repos/$repo/pulls?per_page=1" --jq length)" || return 1
  echo "open PRs on first page: $n"
}

RESULTS=""
result_of() { printf '%s' "$RESULTS" | sed -n "s/^$1=//p"; }

ONLY=""
case "${1:-}" in
  --only) ONLY=",${2:?--only needs a comma-separated list of ids},";;
  "") ;;
  *) echo "usage: $0 [--only id,id,...]" >&2; exit 2;;
esac
if [ -n "$ONLY" ]; then
  for id in $(printf '%s' "$ONLY" | tr ',' ' '); do
    printf '%s\n' "$SURFACES" | grep -q "^$id|" || { echo "unknown surface: $id" >&2; exit 2; }
  done
fi

TMPROOT="${TMPDIR:-/tmp}"
LOGDIR="$(mktemp -d "${TMPROOT%/}/cloud-smoke.XXXXXX")"
TABLE="| surface | id | result | time |
|---|---|---|---|"
FAILS=""
failed=0

while IFS='|' read -r id label needs cmd; do
  [ -n "$id" ] || continue
  case "$ONLY" in ""|*",$id,"*) ;; *) continue;; esac
  result=PASS unmet=""
  for n in $needs; do need "$n" || { unmet=$n; break; }; done
  start=$SECONDS
  if [ -n "$unmet" ]; then
    result="SKIP($unmet)"
  else
    echo "running $id ..." >&2
    ( cd "$REPO" && eval "$cmd" ) >"$LOGDIR/$id.log" 2>&1 </dev/null || result=FAIL
  fi
  dur=$((SECONDS - start))
  RESULTS+="$id=$result"$'\n'
  TABLE+=$'\n'"| $label | \`$id\` | $result | ${dur}s |"
  if [ "$result" = FAIL ]; then
    failed=1
    FAILS+=$'\n'"#### \`$id\` (last 20 lines, full log $LOGDIR/$id.log)"$'\n\n```\n'"$(tail -n 20 "$LOGDIR/$id.log")"$'\n```\n'
  fi
done <<EOF
$SURFACES
EOF

printf '%s\n' "$TABLE"
[ -n "$FAILS" ] && printf '%s\n' "$FAILS"
printf '\nNot runnable in cloud:\n\n'
printf '%s\n' "$NOT_RUNNABLE" | while IFS='|' read -r what why; do
  [ -n "$what" ] && printf -- '- %s: %s\n' "$what" "$why"
done
exit "$failed"
