#!/usr/bin/env bash
# The VM state this leaves is cached only if it ends within about 5 minutes. Must exit 0.
set -u
LOG=/tmp/cloud-setup.log
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || true

PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1]' 2>/dev/null)"
npm install -g "pnpm@${PNPM_VERSION:-10.33.1}" >>"$LOG" 2>&1 || true

command -v jq >/dev/null 2>&1 || { apt-get update && apt-get install -y jq; } >>"$LOG" 2>&1 || true

# The gh apt repo lives on cli.github.com, outside the default allowlist; release tarballs
# come from github.com, which is inside it.
GH_VERSION=2.101.0
GH_ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
command -v gh >/dev/null 2>&1 || { curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
  | tar -xz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh; } || true

# User-settings plugins do not follow you into the cloud; install pstack in the VM itself.
claude plugin marketplace add michael-denyer/pstack-claude >>"$LOG" 2>&1 || true
claude plugin install pstack@pstack-claude --scope user >>"$LOG" 2>&1 || true

# Not `pnpm fetch`: the hook's install then purges its node_modules, which pnpm refuses without a TTY.
[ -f pnpm-lock.yaml ] && timeout 180 pnpm install --frozen-lockfile >>"$LOG" 2>&1 || true

exit 0
