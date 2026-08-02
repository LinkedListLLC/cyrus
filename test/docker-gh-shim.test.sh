#!/usr/bin/env bash
# Tests for docker-gh-shim.sh — the `gh` wrapper installed in the container.
#
# The wrapper is the only thing that keeps `gh pr create` authenticated in a
# session that has run for longer than the one-hour life of an installation
# token, so its two failure modes both matter:
#
#   * Running gh with no credential when minting failed. That produces a
#     confusing error much later, in the middle of a session.
#   * Changing anything at all when the App variables are absent.
#
# Run: ./test/docker-gh-shim.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

fail() {
  echo "  FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected to find '$2' in: $1" ;;
  esac
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

# Run the wrapper against stubs for `gh-real` and `cyrus`. The stub gh-real
# reports the token it was given, so the assertions can read what the wrapper
# put into the environment.
#
# $1: the exit code the `cyrus github-token` stub returns.
# rest: KEY=value pairs exported before the wrapper runs.
run_shim() {
  local token_exit="$1"
  shift
  local workdir
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/bin"

  cat >"$workdir/bin/cyrus" <<STUB
#!/bin/sh
[ "\$1" = "github-token" ] || { echo "unexpected args: \$*" >&2; exit 64; }
[ "$token_exit" -eq 0 ] || { echo "mint failed" >&2; exit $token_exit; }
echo "minted-token"
STUB

  cat >"$workdir/bin/gh-real" <<'STUB'
#!/bin/sh
echo "gh-real args=$* GH_TOKEN=${GH_TOKEN:-unset} GITHUB_TOKEN=${GITHUB_TOKEN:-unset}"
STUB

  chmod +x "$workdir/bin/cyrus" "$workdir/bin/gh-real"

  # The wrapper execs /usr/local/bin/gh-real by absolute path, which is not
  # writable here. Point it at the stub instead.
  sed 's|^GH_REAL=.*|GH_REAL='"$workdir"'/bin/gh-real|' \
    "$REPO_ROOT/docker-gh-shim.sh" >"$workdir/bin/gh"
  chmod +x "$workdir/bin/gh"

  (
    export PATH="$workdir/bin:$PATH"
    for pair in "$@"; do
      export "${pair?}"
    done
    "$workdir/bin/gh" pr create --title x 2>&1
    echo "exit=$?"
  )
  rm -rf "$workdir"
}

echo "docker-gh-shim.sh"

echo "- App mode passes a freshly minted token to gh"
OUT="$(run_shim 0 GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2)"
assert_contains "$OUT" "GH_TOKEN=minted-token"
assert_contains "$OUT" "GITHUB_TOKEN=minted-token"
assert_contains "$OUT" "args=pr create --title x"
assert_contains "$OUT" "exit=0"

echo "- App mode refuses to run gh when minting fails"
OUT="$(run_shim 1 GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2)"
assert_contains "$OUT" "Refusing to run gh without a credential"
assert_contains "$OUT" "exit=1"
case "$OUT" in
  *gh-real*) fail "gh-real must not run when minting fails" ;;
esac

echo "- the App variables absent leaves the environment untouched"
OUT="$(run_shim 1 GH_TOKEN=pat-value)"
assert_contains "$OUT" "GH_TOKEN=pat-value"
assert_contains "$OUT" "exit=0"

echo "- no credential at all still runs gh, as it did before"
OUT="$(run_shim 1 CYRUS_UNUSED=1)"
assert_contains "$OUT" "GH_TOKEN=unset"
assert_contains "$OUT" "exit=0"

echo "- the recursion guard skips minting a second time"
OUT="$(run_shim 1 GITHUB_APP_ID=1 GITHUB_APP_INSTALLATION_ID=2 CYRUS_GH_SHIM=1)"
assert_contains "$OUT" "GH_TOKEN=unset"
assert_contains "$OUT" "exit=0"

if [ "$FAILURES" -eq 0 ]; then
  echo "All docker-gh-shim.sh checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
