#!/bin/sh
# Wrapper for the GitHub CLI. The Dockerfile installs this at
# /usr/local/bin/gh and moves the real binary to /usr/local/bin/gh-real.
# See docs/DOKPLOY.md.
#
# WHY THIS EXISTS
#
# A GitHub App installation token expires one hour after it is minted, and the
# gh CLI reads its credential from the environment only when the process
# starts. Agent sessions frequently run for more than one hour, and they open
# the pull request at the end of the session. A token that the entrypoint put
# into the environment once, at container boot, is therefore already expired at
# the moment it is needed. This wrapper mints a token for each gh call instead.
#
# When GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are absent, the wrapper
# touches nothing and execs the real binary. The personal-access-token setup
# then keeps exactly the behaviour it had before the App existed.
set -u

GH_REAL=/usr/local/bin/gh-real

# Recursion guard. The wrapper always execs GH_REAL by absolute path, so it
# cannot reach itself; this also protects gh extensions, which run as
# subprocesses and can call gh again.
if [ -n "${CYRUS_GH_SHIM:-}" ]; then
  exec "$GH_REAL" "$@"
fi
CYRUS_GH_SHIM=1
export CYRUS_GH_SHIM

if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_INSTALLATION_ID:-}" ]; then
  # `cyrus github-token` prints the token alone on stdout. Its warnings go to
  # stderr, so they stay visible in the session log.
  if ! CYRUS_GH_SHIM_TOKEN="$(cyrus github-token)"; then
    echo "ERROR: 'cyrus github-token' failed." >&2
    echo "Refusing to run gh without a credential: an unauthenticated call" >&2
    echo "fails later and with a less clear message." >&2
    exit 1
  fi
  GH_TOKEN="$CYRUS_GH_SHIM_TOKEN"
  GITHUB_TOKEN="$CYRUS_GH_SHIM_TOKEN"
  export GH_TOKEN GITHUB_TOKEN
fi

exec "$GH_REAL" "$@"
