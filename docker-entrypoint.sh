#!/usr/bin/env bash
# Entrypoint for the Dokploy/self-host container. See docs/DOKPLOY.md.
set -e

# Non-interactive GitHub auth for cloning private repos. Provide a fine-grained
# PAT (contents R/W on the target repos) as GH_TOKEN in the Dokploy env panel.
# We rewrite github.com HTTPS URLs to embed the token (stateless, per boot), and
# export GITHUB_TOKEN so the gh CLI and Cyrus's GitHub-App fallback pick it up.
if [ -n "${GH_TOKEN:-}" ]; then
  git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  export GITHUB_TOKEN="${GH_TOKEN}"
fi

# First-run helper. Set CYRUS_SETUP_IDLE=true to keep the container up WITHOUT
# starting the server, so the one-time `cyrus self-auth-linear` OAuth flow can
# bind :3456 for its callback. Run the setup commands in the Dokploy terminal,
# then remove the env var and redeploy to start Cyrus normally.
if [ "${CYRUS_SETUP_IDLE:-}" = "true" ]; then
  echo ">> CYRUS_SETUP_IDLE=true — idling for one-time setup."
  echo ">> Run:  cyrus self-auth-linear   then   cyrus self-add-repo <git-url> \"<name>\""
  echo ">> Then unset CYRUS_SETUP_IDLE and redeploy."
  exec sleep infinity
fi

exec node /app/apps/cli/dist/src/app.js
