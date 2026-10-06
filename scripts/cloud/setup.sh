#!/usr/bin/env bash
# claude.ai environment setup script. The shared environment's bootstrap runs it from the
# repo root; it can also be pasted on its own. Runs as root on the cloud VM before Claude
# Code starts. The VM state it leaves is cached only if it ends within about 5 minutes, so
# slow downloads belong here, not in the SessionStart hook. Must exit 0.
set -u
LOG=/tmp/cloud-setup.log
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || true

# Same pnpm as CI (packageManager), so the lockfile resolves identically.
PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1]' 2>/dev/null)"
npm install -g "pnpm@${PNPM_VERSION:-10.33.1}" >>"$LOG" 2>&1 || true

# test/*.test.sh need jq.
command -v jq >/dev/null 2>&1 || { apt-get update && apt-get install -y jq; } >>"$LOG" 2>&1 || true

# The VM has no gh. The apt repo lives on cli.github.com, outside the default allowlist;
# release tarballs come from github.com, which is inside it. Pinned for a reproducible cache.
GH_VERSION=2.101.0
GH_ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
  | tar -xz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh || true

# User-settings plugins do not follow you into the cloud; install pstack in the VM itself.
claude plugin marketplace add michael-denyer/pstack-claude >>"$LOG" 2>&1 || true
claude plugin install pstack@pstack-claude --scope user >>"$LOG" 2>&1 || true

# Warms the store and node_modules for the cached VM, so the hook's install is a fast no-op.
# Not `pnpm fetch`: its node_modules layout differs, and the hook's install then wants to
# purge it, which pnpm refuses without a TTY (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
[ -f pnpm-lock.yaml ] && timeout 180 pnpm install --frozen-lockfile >>"$LOG" 2>&1 || true

exit 0
