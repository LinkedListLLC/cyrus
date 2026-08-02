# Cyrus — headless self-host image (builds from source).
# Deployed on Dokploy as a single Application (Dockerfile build type).
# See docs/DOKPLOY.md for the full deploy runbook.
#
# Every input to this build is pinned, because `pnpm install --frozen-lockfile`
# pinning the workspace is worth little if the toolchain around it floats. Base
# image by digest, Claude Code by version, Grok by installed-version assertion.
# See the comment on each.
#
# Digest-pinned: `22-bookworm` is a moving tag, so an unpinned FROM makes the
# image non-reproducible and lets a base change land without a commit. Resolved
# 2026-07-29. To refresh:
#   docker buildx imagetools inspect node:22-bookworm --format '{{.Manifest.Digest}}'
FROM node:22-bookworm@sha256:7725a5c2c83eed1d36258c66efae14b1ceccd021db9ed1d9559d3335ed3d68ed

# Runtime deps: git (clone + per-issue worktrees), jq (Claude Code stream-json
# parsing), gh (PR creation). Installs the GitHub CLI apt repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq curl ca-certificates gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# GitHub's stacked-PR extension, so sessions can run `gh stack` (CYR-60).
#
# No build-time credential is needed: `github/gh-stack` is a public repo, and
# `gh extension install` reads its releases anonymously — verified on gh 2.96
# with GH_TOKEN, GITHUB_TOKEN and the gh config directory all absent. The
# install lands in /root/.local/share/gh/extensions, which is an image layer
# and outside the persisted /root/.cyrus volume, so a redeploy cannot lose it.
#
# Version-pinned, like every other input to this build. `--pin` does two things:
# it selects the release instead of taking whatever is latest on the day of the
# build, and it records `ispinned: true` in the extension manifest, so a session
# running `gh extension upgrade` leaves this version alone.
#
# The assertion below is not just a re-read of the pin. This is a *precompiled*
# extension: gh downloads the release asset for the build platform's
# architecture, and a wrong or corrupt asset installs cleanly and only fails the
# first time a session calls it. Executing the binary at build time is what
# turns that into a failed build.
ARG GH_STACK_VERSION=v0.1.0
RUN gh extension install github/gh-stack --pin "$GH_STACK_VERSION" \
 && GH_STACK_ACTUAL="$(gh stack --version | tr -d '\r')" \
 && echo "gh-stack: $GH_STACK_ACTUAL (expected $GH_STACK_VERSION)" \
 && if ! echo "$GH_STACK_ACTUAL" | grep -qF "${GH_STACK_VERSION#v}"; then \
      echo "ERROR: gh-stack reports a different version than the pinned ${GH_STACK_VERSION}." >&2; \
      exit 1; \
    fi

# The Claude Code CLI that Cyrus drives (provides the `claude` binary on PATH).
#
# Version-pinned, and pinned to the Claude Code that `claude-agent-sdk@0.3.220`
# bundles — verified 2026-07-29: the SDK's own native binary reports 2.1.220.
# Unpinned, every rebuild could pull a different Claude Code than the SDK this
# repo tests against, and that now costs capability rather than just
# consistency: `deriveBuiltInTools` drops any tool name absent from
# `availableTools`, which is kept in sync with the SDK version. A CLI that
# renamed or added a tool would have it silently withheld from every session.
#
# Bump this in lockstep with `@anthropic-ai/claude-agent-sdk` in
# packages/*/package.json, and re-run ./scripts/extract-claude-tools.sh.
RUN npm install -g @anthropic-ai/claude-code@2.1.220

# The Grok Build CLI that the grok-runner drives as `grok agent stdio`.
# xAI publishes no official npm package (`@xai/grok-cli` does not exist; the npm
# results are third-party forks), so this is their install script.
#
# ⚠️ RESIDUAL RISK, NAMED: this is the one unverified remote script executed at
# build time. `curl | bash` from x.ai means whatever that URL serves on the day
# of the build runs as root with full network access, and there is no checksum
# or signature to verify it against — xAI publishes no artifact we could hash.
# It is accepted only because there is no alternative distribution channel for
# this CLI, and it is bounded three ways: the installer takes the wanted version
# as its first argument, so the *binary* is pinned even though the *script* is
# not; `GROK_EXPECTED_VERSION` below then asserts what actually landed; and
# `GROK_DISABLE_AUTOUPDATER=1` stops the binary replacing itself at runtime.
#
# The version argument is load-bearing, not decoration. This block used to run
# the installer bare, which resolves to "latest stable", while the assertion
# stayed pinned to a fixed version. That pairing fails the build on the day xAI
# ships anything — and it did, when 0.2.118 replaced 0.2.114 and every deploy
# stopped. Pinning the install makes the build reproducible; the assertion then
# only has to catch an installer that ignores its own argument.
#
# Leave `GROK_EXPECTED_VERSION` empty to take the latest and skip both the pin
# and the assertion.
#
# The installer keeps the real binary in $HOME/.grok/downloads and installs only
# *symlinks* to it — both at $GROK_BIN_DIR/grok and, when running as root, at
# /usr/local/bin/grok. Every one of those links would break here: /root/.grok is
# redirected into the persisted volume at runtime (see docker-entrypoint.sh), so
# nothing baked into the image at that path survives. Hence: install under a
# throwaway HOME, resolve the symlink chain to the actual file, and copy *that*
# into /usr/local/bin — a real, standalone binary on PATH and outside the volume.
# The trailing `rm -rf /root/.grok` clears the empty directory the CLI creates on
# its first run; leaving it would block the entrypoint's symlink and silently
# cost us auth persistence.
ARG GROK_EXPECTED_VERSION=0.2.114
RUN GROK_TMP="$(mktemp -d)" \
 # Fetch the installer to a file rather than piping it, so the version can be
 # passed as an argument. Unquoted on purpose: an empty GROK_EXPECTED_VERSION
 # must expand to no argument at all, which is what selects "latest stable".
 && curl -fsSL https://x.ai/cli/install.sh -o "$GROK_TMP/install.sh" \
 && HOME="$GROK_TMP" GROK_BIN_DIR="$GROK_TMP/bin" \
      bash "$GROK_TMP/install.sh" $GROK_EXPECTED_VERSION \
 && GROK_REAL="$(readlink -f "$GROK_TMP/bin/grok")" \
 && rm -f /usr/local/bin/grok /usr/local/bin/agent \
 && cp "$GROK_REAL" /usr/local/bin/grok \
 && chmod +x /usr/local/bin/grok \
 && rm -rf "$GROK_TMP" \
 # Assert the version rather than just proving the binary runs. With the pin
 # above this should never fire; it stays because it is what would catch an
 # installer that silently ignores its version argument. Override with
 # `--build-arg GROK_EXPECTED_VERSION=` (empty) to accept whatever ships.
 && GROK_ACTUAL="$(grok --version | tr -d '\r')" \
 && echo "grok: $GROK_ACTUAL (expected ${GROK_EXPECTED_VERSION:-any})" \
 && if [ -n "$GROK_EXPECTED_VERSION" ] \
      && ! echo "$GROK_ACTUAL" | grep -qF "$GROK_EXPECTED_VERSION"; then \
      echo "ERROR: grok version drifted from the tested $GROK_EXPECTED_VERSION." >&2; \
      echo "Re-test the grok-runner against it, then bump GROK_EXPECTED_VERSION." >&2; \
      exit 1; \
    fi \
 && rm -rf /root/.grok

# pnpm via corepack, pinned to the repo's packageManager version.
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.1 --activate

WORKDIR /app
COPY . .

# Skip any transitive Electron binary download — this headless image never runs
# the desktop app (the root `build` script already excludes @cyrus/electron).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_electron_skip_binary_download=1

RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && chmod +x /app/docker-entrypoint.sh \
 && printf '#!/bin/sh\nexec node /app/apps/cli/dist/src/app.js "$@"\n' > /usr/local/bin/cyrus \
 && chmod +x /usr/local/bin/cyrus

# Route every `gh` call through a wrapper that mints a fresh GitHub App
# installation token — see docker-gh-shim.sh for why a token cannot be injected
# once at boot. The wrapper calls `cyrus`, so this step must come after the
# build step above that creates /usr/local/bin/cyrus.
#
# The move must also come after the `gh extension install` step near the top of
# this file, which needs the real `gh` on PATH under its own name.
#
# The final `gh --version` is a build-time smoke test of the wrapper, not a
# version check: the App variables are absent during the build, so it proves
# the wrapper is executable and reaches the real binary on the inert path.
RUN mv "$(command -v gh)" /usr/local/bin/gh-real \
 && install -m 0755 /app/docker-gh-shim.sh /usr/local/bin/gh \
 && gh --version

# CYRUS_HOST_EXTERNAL=true → bind 0.0.0.0 so Traefik can reach the container.
ENV CYRUS_SERVER_PORT=3456
ENV CYRUS_HOST_EXTERNAL=true

# Behind a reverse proxy (Traefik/Cloudflare on Dokploy) the source IP Cyrus
# sees is the proxy's edge, not Linear's GCP webhook IP — so the built-in
# source-IP allowlist (which CYRUS_HOST_EXTERNAL auto-enables) rejects every
# webhook. The LINEAR_WEBHOOK_SECRET HMAC signature is the real authentication,
# so disable the IP allowlist here. Set to "true" only if the container is
# exposed directly to the internet with no proxy in front.
ENV WEBHOOK_IP_VALIDATION=false

# Claude Code keeps every conversation transcript in its config directory, at
# projects/<sanitized-cwd>/<session-id>.jsonl. That directory defaults to
# /root/.claude — outside the volume, so a redeploy deletes it. Cyrus's own
# state IS in the volume and keeps the Claude session ID of each open Linear
# session, so after a redeploy it resumes IDs the CLI can no longer find and
# every one of those sessions dead-ends on "No conversation found with session
# ID" (CYR-53). Point the whole store into the volume instead.
#
# CLAUDE_CONFIG_DIR moves the entire store, including the top-level
# .claude.json that otherwise sits beside the directory (verified: projects/,
# sessions/, backups/ and .claude.json all follow it). A symlink of
# /root/.claude would leave that file behind on the ephemeral layer.
#
# The worktrees keying those project directories live at
# /root/.cyrus/worktrees, which is also in the volume, so the paths — and
# therefore the transcript lookup keys — stay stable across redeploys.
#
# Auth is unaffected: sessions authenticate from ANTHROPIC_API_KEY /
# CLAUDE_CODE_OAUTH_TOKEN in the environment, which the runner forwards
# explicitly.
ENV CLAUDE_CONFIG_DIR=/root/.cyrus/claude

# Grok Build. GROK_PATH pins the binary we baked in above, so resolution never
# falls through to a stale ~/.grok/bin/grok inside the volume. GROK_HOME points
# Cyrus's grok-runner at a directory *inside* the persisted /root/.cyrus volume,
# which the entrypoint also symlinks /root/.grok to — belt and braces, because
# the grok CLI's own tooling is $HOME/.grok-centric while Cyrus reads $GROK_HOME.
# Auto-update is off: the binary sits in a read-only image layer, and a silent
# self-update would drift the container away from the image it was built from.
ENV GROK_PATH=/usr/local/bin/grok
ENV GROK_HOME=/root/.cyrus/grok
ENV GROK_DISABLE_AUTOUPDATER=1

EXPOSE 3456

ENTRYPOINT ["/app/docker-entrypoint.sh"]
