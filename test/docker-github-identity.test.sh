#!/usr/bin/env bash
# Tests for docker-github-identity.sh — the GitHub credential setup that
# docker-entrypoint.sh sources at container boot.
#
# The two behaviours that matter most are hard to see by reading the script:
#
#   * In GitHub App mode the `url.insteadOf` rewrite must NOT be installed. The
#     rewrite embeds one token into every remote URL, which pins a credential
#     that dies after one hour and stops git from consulting the credential
#     helper. Leaving it in makes the whole design silently stop working.
#
#   * With the App variables absent, the behaviour must be identical to before.
#
# Run: ./test/docker-github-identity.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
CASE=""

# jq parses the stubbed GitHub API response, exactly as it does in the image.
command -v jq >/dev/null || { echo "jq is required to run these tests"; exit 1; }

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

# Run the identity setup in a subshell with a throwaway git config and a stub
# PATH, then print the resulting git config followed by the value of
# GITHUB_TOKEN. Every variable the script reads is passed in as `KEY=value`.
run_identity() {
  local workdir
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/home" "$workdir/bin"

  # Stub `curl` and `jq` so the bot-identity lookup never touches the network.
  # CYRUS_STUB_BOT_ID is read by the stub: empty means "lookup failed".
  cat >"$workdir/bin/curl" <<'STUB'
#!/bin/sh
[ -n "${CYRUS_STUB_BOT_ID:-}" ] || exit 22
echo "{\"id\": ${CYRUS_STUB_BOT_ID}}"
STUB
  chmod +x "$workdir/bin/curl"

  (
    set -euo pipefail
    export PATH="$workdir/bin:$PATH"
    export GIT_CONFIG_GLOBAL="$workdir/gitconfig"
    export CYRUS_HOME_DIR="$workdir/home"
    for pair in "$@"; do
      export "${pair?}"
    done
    # shellcheck source=../docker-github-identity.sh
    . "$REPO_ROOT/docker-github-identity.sh"
    cyrus_configure_github_identity >/dev/null 2>&1
    # Both commands fail when no credential was configured at all, which is the
    # correct outcome for that case: the script writes no git config file.
    git config --global --list 2>/dev/null || true
    echo "GITHUB_TOKEN=${GITHUB_TOKEN:-}"
    stat -f '%Lp' "$GIT_CONFIG_GLOBAL" 2>/dev/null \
      || stat -c '%a' "$GIT_CONFIG_GLOBAL" 2>/dev/null \
      || echo "no-config-file"
  )
  rm -rf "$workdir"
}

echo "docker-github-identity.sh"

# --- Criterion 4: the App variables absent means no change -----------------
CASE="personal access token only"
echo "- $CASE"
OUT="$(run_identity GH_TOKEN=pat-value)"
assert_contains "$OUT" "url.https://x-access-token:pat-value@github.com/.insteadof=https://github.com/"
assert_contains "$OUT" "GITHUB_TOKEN=pat-value"
assert_not_contains "$OUT" "credential.https://github.com.helper"

CASE="no credentials at all"
echo "- $CASE"
OUT="$(run_identity CYRUS_UNUSED=1)"
assert_not_contains "$OUT" "insteadof"
assert_not_contains "$OUT" "credential.https://github.com.helper"
assert_contains "$OUT" "GITHUB_TOKEN="

# --- Criterion 2: App mode installs the helper and NOT the rewrite ---------
CASE="GitHub App mode"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=12345 GITHUB_APP_INSTALLATION_ID=67890)"
assert_contains "$OUT" "credential.https://github.com.helper"
assert_contains "$OUT" "cyrus github-token"
assert_contains "$OUT" "username=x-access-token"
# The single most important assertion in this file.
assert_not_contains "$OUT" "insteadof"

CASE="GitHub App mode keeps GITHUB_TOKEN as the fallback"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=12345 GITHUB_APP_INSTALLATION_ID=67890 GH_TOKEN=pat-value)"
assert_contains "$OUT" "GITHUB_TOKEN=pat-value"
# Even with a PAT present, App mode must not install the rewrite.
assert_not_contains "$OUT" "insteadof"

CASE="git config file is 0600"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=12345 GITHUB_APP_INSTALLATION_ID=67890)"
assert_eq "$(echo "$OUT" | tail -n 1)" "600"

# --- Bot commit identity ---------------------------------------------------
CASE="bot commit identity when the slug resolves"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2 \
  GITHUB_APP_SLUG=cyrus-linkedlist CYRUS_STUB_BOT_ID=987654)"
assert_contains "$OUT" "user.name=cyrus-linkedlist[bot]"
assert_contains "$OUT" "user.email=987654+cyrus-linkedlist[bot]@users.noreply.github.com"

CASE="GITHUB_APP_NAME overrides the display name"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2 \
  GITHUB_APP_SLUG=cyrus-linkedlist GITHUB_APP_NAME="Cyrus" CYRUS_STUB_BOT_ID=987654)"
assert_contains "$OUT" "user.name=Cyrus"

CASE="a failed bot lookup only warns"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2 \
  GITHUB_APP_SLUG=cyrus-linkedlist)"
assert_not_contains "$OUT" "user.email="
# The credential helper is still installed, so the container still works.
assert_contains "$OUT" "credential.https://github.com.helper"

CASE="no slug means no commit identity"
echo "- $CASE"
OUT="$(run_identity GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2)"
assert_not_contains "$OUT" "user.email="

if [ "$FAILURES" -eq 0 ]; then
  echo "All docker-github-identity.sh checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
