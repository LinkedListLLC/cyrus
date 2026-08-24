#!/usr/bin/env bash
# Tests for docker-infisical-identity.sh — the Infisical login that
# docker-entrypoint.sh sources at container boot.
#
# The behaviours that matter most are hard to see by reading the script:
#
#   * No credentials means a note, not a failed boot, and infisical is not called.
#   * An incomplete pair means a warning and no login attempt.
#   * A successful Universal Auth login exports INFISICAL_TOKEN and unsets the
#     long-lived client id/secret. The token must not appear in the boot log.
#   * A failed login warns and continues, so a bad secret does not take down Cyrus.
#
# Run: ./test/docker-infisical-identity.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
CASE=""

fail() {
  echo "  FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected to find '$2'" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected NOT to find '$2'" ;;
    *) ;;
  esac
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

# Run the identity setup in a subshell with a throwaway PATH.
# $1: stub | fail | none
# rest: KEY=value pairs exported before the function runs.
run_identity() {
  local mode="$1"
  shift
  local workdir
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/bin"

  if [ "$mode" = "stub" ] || [ "$mode" = "fail" ]; then
    cat >"$workdir/bin/infisical" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" > "${CYRUS_INFISICAL_ARGV_FILE}"
if [ "${CYRUS_STUB_LOGIN_FAIL:-}" = "1" ]; then
  echo "login failed" >&2
  exit 1
fi
echo "fake-ua-token"
STUB
    chmod +x "$workdir/bin/infisical"
  fi

  (
    set -euo pipefail
    if [ "$mode" = "none" ]; then
      export PATH="$workdir/bin"
    else
      export PATH="$workdir/bin:$PATH"
    fi
    export CYRUS_INFISICAL_ARGV_FILE="$workdir/argv"
    unset INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET
    if [ "$mode" = "fail" ]; then
      export CYRUS_STUB_LOGIN_FAIL=1
    fi
    for pair in "$@"; do
      export "${pair?}"
    done
    # shellcheck source=../docker-infisical-identity.sh
    . "$REPO_ROOT/docker-infisical-identity.sh"
    cyrus_configure_infisical_identity
    echo "INFISICAL_TOKEN=${INFISICAL_TOKEN:-}"
    echo "INFISICAL_CLIENT_ID=${INFISICAL_CLIENT_ID:-}"
    echo "INFISICAL_CLIENT_SECRET=${INFISICAL_CLIENT_SECRET:-}"
    if [ -f "$workdir/argv" ]; then
      echo "ARGV=$(cat "$workdir/argv")"
    else
      echo "ARGV="
    fi
  ) 2>&1
  rm -rf "$workdir"
}

echo "docker-infisical-identity.sh"

CASE="no credentials at all"
echo "- $CASE"
OUT="$(run_identity stub CYRUS_UNUSED=1)"
assert_contains "$OUT" "INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are not set"
assert_contains "$OUT" "INFISICAL_TOKEN="
assert_eq "$(echo "$OUT" | grep '^INFISICAL_TOKEN=' )" "INFISICAL_TOKEN="
assert_not_contains "$OUT" "exchanging Universal Auth"
assert_eq "$(echo "$OUT" | grep '^ARGV=' )" "ARGV="

CASE="client id only"
echo "- $CASE"
OUT="$(run_identity stub INFISICAL_CLIENT_ID=only-id)"
assert_contains "$OUT" "Infisical machine identity is incomplete"
assert_eq "$(echo "$OUT" | grep '^INFISICAL_TOKEN=' )" "INFISICAL_TOKEN="
assert_eq "$(echo "$OUT" | grep '^ARGV=' )" "ARGV="

CASE="client secret only"
echo "- $CASE"
OUT="$(run_identity stub INFISICAL_CLIENT_SECRET=only-secret)"
assert_contains "$OUT" "Infisical machine identity is incomplete"
assert_eq "$(echo "$OUT" | grep '^INFISICAL_TOKEN=' )" "INFISICAL_TOKEN="
assert_eq "$(echo "$OUT" | grep '^ARGV=' )" "ARGV="

CASE="successful Universal Auth login"
echo "- $CASE"
OUT="$(run_identity stub INFISICAL_CLIENT_ID=client-id-value INFISICAL_CLIENT_SECRET=client-secret-value)"
assert_contains "$OUT" "INFISICAL_TOKEN=fake-ua-token"
assert_eq "$(echo "$OUT" | grep '^INFISICAL_CLIENT_ID=' )" "INFISICAL_CLIENT_ID="
assert_eq "$(echo "$OUT" | grep '^INFISICAL_CLIENT_SECRET=' )" "INFISICAL_CLIENT_SECRET="
assert_contains "$OUT" "ARGV="
assert_contains "$OUT" "--method=universal-auth"
assert_contains "$OUT" "--silent"
assert_contains "$OUT" "--plain"
assert_contains "$OUT" "--client-id=client-id-value"
assert_contains "$OUT" "--client-secret=client-secret-value"
assert_contains "$OUT" "Infisical token exported"
# Boot log lines start with `>>`. None of them may contain the minted token.
while IFS= read -r line; do
  case "$line" in
    '>>'*)
      case "$line" in
        *fake-ua-token*) fail "token leaked in boot log: $line" ;;
      esac
      ;;
  esac
done <<EOF
$OUT
EOF

CASE="failed login does not take down the container"
echo "- $CASE"
OUT="$(run_identity fail INFISICAL_CLIENT_ID=client-id-value INFISICAL_CLIENT_SECRET=client-secret-value)"
assert_contains "$OUT" "Infisical Universal Auth login failed"
assert_eq "$(echo "$OUT" | grep '^INFISICAL_TOKEN=' )" "INFISICAL_TOKEN="
assert_contains "$OUT" "INFISICAL_CLIENT_SECRET=client-secret-value"

CASE="infisical missing from PATH"
echo "- $CASE"
OUT="$(run_identity none INFISICAL_CLIENT_ID=client-id-value INFISICAL_CLIENT_SECRET=client-secret-value)"
assert_contains "$OUT" "infisical is not on PATH"
assert_eq "$(echo "$OUT" | grep '^INFISICAL_TOKEN=' )" "INFISICAL_TOKEN="
assert_eq "$(echo "$OUT" | grep '^ARGV=' )" "ARGV="

if [ "$FAILURES" -eq 0 ]; then
  echo "All docker-infisical-identity.sh checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
