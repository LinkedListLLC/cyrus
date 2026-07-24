# Cyrus — headless self-host image (builds from source).
# Deployed on Dokploy as a single Application (Dockerfile build type).
# See docs/DOKPLOY.md for the full deploy runbook.
FROM node:22-bookworm

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

# The Claude Code CLI that Cyrus drives (provides the `claude` binary on PATH).
RUN npm install -g @anthropic-ai/claude-code

# The Grok Build CLI that the grok-runner drives as `grok agent stdio`.
# xAI publishes no official npm package (`@xai/grok-cli` does not exist; the npm
# results are third-party forks), so this is their install script.
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
RUN GROK_TMP="$(mktemp -d)" \
 && HOME="$GROK_TMP" GROK_BIN_DIR="$GROK_TMP/bin" \
      bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash' \
 && GROK_REAL="$(readlink -f "$GROK_TMP/bin/grok")" \
 && rm -f /usr/local/bin/grok /usr/local/bin/agent \
 && cp "$GROK_REAL" /usr/local/bin/grok \
 && chmod +x /usr/local/bin/grok \
 && rm -rf "$GROK_TMP" \
 && grok --version \
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
