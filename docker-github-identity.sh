#!/usr/bin/env bash
# Configure the GitHub credential for the container. Sourced by
# docker-entrypoint.sh. See docs/DOKPLOY.md.
#
# Kept out of the entrypoint so it can be run on its own against a temporary
# directory — see test/docker-github-identity.test.sh.
#
# Two mutually exclusive modes, in priority order:
#
#   1. GitHub App. Set GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID, and put
#      the App private key at $CYRUS_HOME/github-app.pem. Pull requests then
#      come from <app-slug>[bot], so every human on the team is a third party
#      who can approve them and can receive a review request.
#
#   2. Personal access token. Set GH_TOKEN. This is the original behaviour and
#      stays identical: nothing that runs in App mode runs here, and nothing
#      here changed.
#
# Both modes write git configuration to a file OUTSIDE $HOME, via
# GIT_CONFIG_GLOBAL. It used to be written to /root/.gitconfig — the same $HOME
# every agent session runs under — which put the PAT in cleartext on disk where
# a session could read it. `buildHomeDirectoryDisallowedTools` is supposed to
# deny that read, but the whole evidence base of this stack is that tool-layer
# denials are the layer that gets bypassed, and a secret that is not on disk
# needs no denial. 0600, and under /run (tmpfs on a normal host) so it does not
# outlive the container.

# Where the App private key lives. Overridden only by the test.
CYRUS_HOME_DIR="${CYRUS_HOME_DIR:-/root/.cyrus}"

cyrus_init_git_config() {
  export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-/run/cyrus-git/config}"
  mkdir -p "$(dirname "$GIT_CONFIG_GLOBAL")"
  touch "$GIT_CONFIG_GLOBAL"
  chmod 600 "$GIT_CONFIG_GLOBAL"
}

cyrus_configure_github_identity() {
  if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_INSTALLATION_ID:-}" ]; then
    cyrus_configure_github_app_identity
  elif [ -n "${GH_TOKEN:-}" ]; then
    cyrus_configure_github_pat_identity
  fi
}

cyrus_configure_github_app_identity() {
  echo ">> GitHub App mode (app id ${GITHUB_APP_ID})."

  if [ ! -f "${CYRUS_HOME_DIR}/github-app.pem" ]; then
    echo ">> WARNING: ${CYRUS_HOME_DIR}/github-app.pem is missing. Every attempt"
    echo ">> to mint a token will fail, and Cyrus will fall back to GH_TOKEN if"
    echo ">> one is set. Copy the App private key to that path."
  fi

  cyrus_init_git_config

  # A git credential helper, NOT a url.insteadOf rewrite.
  #
  # The rewrite that the personal-access-token mode uses embeds one fixed token
  # into every remote URL. Here that would be wrong twice over: it pins a
  # credential that dies after one hour, and it stops git from ever consulting
  # a credential helper. The helper below runs on each push and each fetch, so
  # a session that has been working for three hours still gets a live token.
  git config --global credential."https://github.com".helper \
    '!f() { echo username=x-access-token; echo "password=$(cyrus github-token)"; }; f'

  cyrus_configure_bot_commit_identity

  # Keep GITHUB_TOKEN exported when a PAT is also present. Cyrus uses it as the
  # last-resort fallback if minting fails — see EdgeWorker.resolveGitHubToken.
  if [ -n "${GH_TOKEN:-}" ]; then
    export GITHUB_TOKEN="${GH_TOKEN}"
  fi
}

# Set the commit identity, so the commits carry the bot as well as the pull
# request. GitHub links a commit to the bot account through the noreply
# address, which needs the bot's numeric user ID. Resolve it from the public
# users endpoint.
#
# This is a label on a commit. It must never stop the container from booting,
# so every failure below only prints a warning.
cyrus_configure_bot_commit_identity() {
  if [ -z "${GITHUB_APP_SLUG:-}" ]; then
    echo ">> NOTE: GITHUB_APP_SLUG is not set, so the commit identity is unchanged."
    echo ">> Set it to the App's URL slug to attribute commits to the bot too."
    return 0
  fi

  local bot_login="${GITHUB_APP_SLUG}[bot]"
  local bot_id
  bot_id="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/users/${GITHUB_APP_SLUG}%5Bbot%5D" \
    | jq -r '.id // empty')" || bot_id=""

  if [ -z "$bot_id" ]; then
    echo ">> WARNING: could not resolve the GitHub user ID for ${bot_login}."
    echo ">> Commits will keep the default identity. Check that GITHUB_APP_SLUG"
    echo ">> matches the App's URL slug exactly."
    return 0
  fi

  local bot_name="${GITHUB_APP_NAME:-$bot_login}"
  local bot_email="${bot_id}+${bot_login}@users.noreply.github.com"

  git config --global user.name "$bot_name"
  git config --global user.email "$bot_email"

  # Also export the identity, because the git config alone does not hold.
  #
  # The session prompt hands the agent the *assignee's* GitHub noreply address
  # (PromptBuilder builds it; standard-issue-assigned-user-prompt.md carries it
  # in the <assignee> block). Nothing instructs the agent to commit as that
  # person, but agents infer it, and observed runs did exactly that: every
  # commit on the bot's own pull requests carried a human's name while this
  # file held the correct bot identity.
  #
  # Git resolves the author as GIT_AUTHOR_* first and configuration second, so
  # exporting wins over both the global file and anything the session sets with
  # `git config` or `git -c`. Only an explicit `git commit --author=...` beats
  # it, and nothing asks for that.
  export GIT_AUTHOR_NAME="$bot_name"
  export GIT_AUTHOR_EMAIL="$bot_email"
  export GIT_COMMITTER_NAME="$bot_name"
  export GIT_COMMITTER_EMAIL="$bot_email"

  echo ">> Git commit identity: $bot_name <$bot_email> (config + GIT_AUTHOR_*)"
}

# Non-interactive GitHub auth for cloning private repos. Provide a fine-grained
# PAT (contents R/W on the target repos) as GH_TOKEN in the Dokploy env panel.
# We rewrite github.com HTTPS URLs to embed the token (stateless, per boot), and
# export GITHUB_TOKEN so the gh CLI and Cyrus's GitHub-App fallback pick it up.
#
# GITHUB_TOKEN is exported, so it remains readable in the environment of any
# child process. That is inherent to how `gh` and Cyrus's GitHub-App fallback
# consume it, and it is recorded in docs/DOKPLOY.md.
cyrus_configure_github_pat_identity() {
  cyrus_init_git_config
  git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  export GITHUB_TOKEN="${GH_TOKEN}"
}
