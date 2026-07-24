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

# Seed a minimal config.json if none exists yet. `cyrus self-auth-linear` and
# `cyrus self-add-repo` both require the file to already exist, but bare `cyrus`
# does not create it — only the sub-directories. This makes first-run setup work
# without a manual step. The guard never clobbers an existing (authed) config.
mkdir -p /root/.cyrus
if [ ! -f /root/.cyrus/config.json ]; then
  echo '{"repositories": []}' > /root/.cyrus/config.json
  echo ">> Seeded an empty /root/.cyrus/config.json (run cyrus self-auth-linear / self-add-repo next)."
fi

# Persist Grok Build auth. `grok login` is a browser OAuth that drops a token in
# the CLI's home directory, and only /root/.cyrus is a Dokploy volume — anything
# written to /root/.grok would be wiped by the next redeploy. Symlinking the
# whole directory into the volume makes the login survive *whichever* path the
# CLI actually writes to: its own tooling is $HOME/.grok-centric (the installer
# reads $HOME/.grok/auth.json and writes $HOME/.grok/config.toml) while Cyrus's
# grok-runner reads $GROK_HOME. Both now resolve to the same persisted place.
# The `grok` binary itself lives at /usr/local/bin/grok, outside the volume, so
# this symlink cannot hide it.
GROK_PERSIST="${GROK_HOME:-/root/.cyrus/grok}"
mkdir -p "$GROK_PERSIST"
if [ -L /root/.grok ]; then
  : # already linked — nothing to do
elif [ ! -e /root/.grok ]; then
  ln -s "$GROK_PERSIST" /root/.grok
elif [ -d /root/.grok ] && [ -z "$(ls -A /root/.grok 2>/dev/null)" ]; then
  # An *empty* directory — the grok CLI creates one on first run. Safe to swap
  # for the symlink, and this self-heals containers built from older images.
  rmdir /root/.grok && ln -s "$GROK_PERSIST" /root/.grok
else
  # A real directory with contents in it. Don't touch it — moving someone's
  # credentials around unattended is worse than printing a warning.
  echo ">> WARNING: /root/.grok is a non-empty directory, not a symlink to $GROK_PERSIST."
  echo ">> Grok auth written there will NOT survive a redeploy. Move it with:"
  echo ">>   mv /root/.grok/* $GROK_PERSIST/ && rmdir /root/.grok && ln -s $GROK_PERSIST /root/.grok"
fi

# First-run helper. Set CYRUS_SETUP_IDLE=true to keep the container up WITHOUT
# starting the server, so the one-time `cyrus self-auth-linear` OAuth flow can
# bind :3456 for its callback. Run the setup commands in the Dokploy terminal,
# then remove the env var and redeploy to start Cyrus normally.
if [ "${CYRUS_SETUP_IDLE:-}" = "true" ]; then
  echo ">> CYRUS_SETUP_IDLE=true — idling for one-time setup."
  echo ">> Run:  cyrus self-auth-linear   then   cyrus self-add-repo <git-url> \"<name>\""
  echo ">> Grok (optional):  grok login    then   grok models   to verify."
  echo ">> Then unset CYRUS_SETUP_IDLE and redeploy."
  exec sleep infinity
fi

exec node /app/apps/cli/dist/src/app.js
