#!/usr/bin/env bash
# Configure Infisical CLI auth for the container. Sourced by
# docker-entrypoint.sh. See docs/DOKPLOY.md.
#
# Kept out of the entrypoint so it can be run on its own against a stub CLI —
# see test/docker-infisical-identity.test.sh.
#
# The container cannot Google-login. It uses a machine identity (Universal
# Auth). Set INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET in the Dokploy
# Environment panel. At boot we mint INFISICAL_TOKEN and export it so
# `infisical run` in product worktrees works. Sessions inherit process.env
# (buildBaseSessionEnv in packages/claude-runner).
#
# After minting, the client id and secret are unset so child processes do not
# inherit the long-lived credential. The token stays in the environment — that
# is how the CLI consumes it, and it is recorded in docs/DOKPLOY.md.
#
# Missing vars: warn and continue. The container still boots. Agents can run
# tests; they cannot start Metro/Next against Infisical.
#
# This function must not fail the entrypoint (`set -e`). Every error path
# returns 0 after a warning.

cyrus_configure_infisical_identity() {
  if [ -z "${INFISICAL_CLIENT_ID:-}" ] && [ -z "${INFISICAL_CLIENT_SECRET:-}" ]; then
    echo ">> NOTE: INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are not set."
    echo ">> Agents will not be able to run Infisical-wrapped start scripts."
    return 0
  fi

  if [ -z "${INFISICAL_CLIENT_ID:-}" ] || [ -z "${INFISICAL_CLIENT_SECRET:-}" ]; then
    echo ">> WARNING: Infisical machine identity is incomplete."
    echo ">> Set both INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET, or neither."
    return 0
  fi

  if ! command -v infisical >/dev/null 2>&1; then
    echo ">> WARNING: infisical is not on PATH. The image should install it."
    return 0
  fi

  echo ">> Infisical machine identity: exchanging Universal Auth for a token."

  local output token
  if ! output="$(infisical login \
      --method=universal-auth \
      --client-id="${INFISICAL_CLIENT_ID}" \
      --client-secret="${INFISICAL_CLIENT_SECRET}" \
      --silent \
      --plain)"; then
    echo ">> WARNING: Infisical Universal Auth login failed."
    echo ">> Check INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET in Dokploy."
    echo ">> Three failed logins lock the identity for five minutes."
    return 0
  fi

  # --plain prints the token. Take the last non-empty line in case a tip leaks.
  token="$(printf '%s\n' "$output" | tr -d '\r' | awk 'NF { line = $0 } END { print line }')"

  if [ -z "$token" ]; then
    echo ">> WARNING: Infisical login printed no token."
    return 0
  fi

  export INFISICAL_TOKEN="$token"
  unset INFISICAL_CLIENT_ID
  unset INFISICAL_CLIENT_SECRET

  echo ">> Infisical token exported (INFISICAL_TOKEN). Client secret unset."
}
