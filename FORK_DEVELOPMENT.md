# Fork development & install (Grok Build support)

> **Temporary doc for this fork.** Delete before opening an upstream PR to `cyrusagents/cyrus`.
>
> Audience: humans **and** coding agents installing this branch on a machine that may already run stock Cyrus.

---

## What this fork is

| Item | Value |
|------|--------|
| Public fork | https://github.com/gautamjain/cyrus |
| Feature branch | `feat/grok-build-support` |
| Branch URL | https://github.com/gautamjain/cyrus/tree/feat/grok-build-support |
| Upstream | https://github.com/cyrusagents/cyrus |
| Purpose | Add **Grok Build** as a Cyrus agent runner (ACP), alongside Claude / Codex / Cursor / Gemini |

Grok is **additive**. Existing Linear / GitHub / Claude setup in `~/.cyrus` should keep working. Prefer testing Grok via labels, not by switching the global default until you are ready.

---

## Should you use an existing Cyrus machine?

**Yes, if** it already has Linear + GitHub (+ Claude) configured.

- **Keep** `~/.cyrus/` (config, tokens, repos) — do **not** wipe it.
- You only replace the **Cyrus binary/code**, not OAuth integrations.
- Leave `"defaultRunner"` as Claude (or unset). Test Grok with Linear label **`grok`** or description tag **`[agent=grok]`**.

---

## Install / replace stock Cyrus (Ubuntu)

Assumes: Node 20+, git, and optionally an existing `cyrus` from `npm install -g cyrus-ai`.

### 0. Stop the running worker

```bash
# Examples — use whatever you use today:
pm2 stop cyrus 2>/dev/null || true
# or: systemctl --user stop cyrus
# or: detach/kill the tmux session running `cyrus`
```

### 1. Clone this branch

```bash
cd ~
git clone -b feat/grok-build-support https://github.com/gautamjain/cyrus.git cyrus-grok
cd ~/cyrus-grok
```

### 2. Build the monorepo

```bash
corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm install
pnpm build
```

### 3. Point `cyrus` at the local CLI

**Option A — npm link (recommended for a “normal” `cyrus` command):**

```bash
cd ~/cyrus-grok/apps/cli
npm link
hash -r
which cyrus
cyrus --version
```

**Option B — run the built entrypoint (no global link):**

```bash
node ~/cyrus-grok/apps/cli/dist/src/app.js start
```

**Option C — PATH wrapper:**

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cyrus <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/cyrus-grok/apps/cli/dist/src/app.js" "$@"
EOF
chmod +x ~/.local/bin/cyrus
# ensure ~/.local/bin is on PATH before any global npm bin
```

### 4. Install and log in to Grok Build (subscription)

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
# ensure ~/.grok/bin is on PATH (installer usually handles this)
export PATH="$HOME/.grok/bin:$PATH"

grok login          # browser or: grok login --device-auth
grok models         # expect: logged in + default model (e.g. grok-4.5)
```

Prefer **`grok login`** (subscription / SuperGrok Heavy). Do **not** set `XAI_API_KEY` unless you intentionally want API billing.

### 5. Config: keep Claude as default while testing

Edit `~/.cyrus/config.json` only if needed. For first tests:

- **Do not** set `"defaultRunner": "grok"` yet.
- Trigger Grok with Linear label **`grok`** / **`xai`**, or issue description **`[agent=grok]`**.

When ready to default everything to Grok:

```json
{
  "defaultRunner": "grok"
}
```

Or env: `CYRUS_DEFAULT_RUNNER=grok`.

### 6. Start with debug logging captured

```bash
export CYRUS_LOG_LEVEL=DEBUG
export PATH="$HOME/.grok/bin:$PATH"

mkdir -p ~/cyrus-debug-logs
cyrus start 2>&1 | tee ~/cyrus-debug-logs/cyrus-$(date +%Y%m%d-%H%M%S).log
```

If you use pm2:

```bash
# After npm link / wrapper is in place:
pm2 start cyrus --name cyrus --update-env
# Or run with env:
CYRUS_LOG_LEVEL=DEBUG pm2 start cyrus --name cyrus --update-env
pm2 logs cyrus --lines 200
```

### 7. Smoke-check Grok from Linear

1. Create or pick a Linear issue on a repo Cyrus already handles.
2. Add label **`grok`** (or put `[agent=grok]` in the description).
3. Assign / delegate to Cyrus as you normally do.
4. Confirm agent activity: model thought, tool actions, final response.
5. Post a follow-up comment and confirm a second turn (resume) works.

---

## Logging (what agents should collect)

### Console levels

Set **`CYRUS_LOG_LEVEL`** to one of: `DEBUG` | `INFO` | `WARN` | `ERROR` | `SILENT`.

Default is `INFO`. Use **`DEBUG`** for fork trials.

Lines look like:

```text
2026-07-22T21:00:00.000Z [INFO ] [EdgeWorker] ...
2026-07-22T21:00:00.000Z [DEBUG] [GrokRunner] Spawning ACP: ...
```

Covers **all** of Cyrus (EdgeWorker, webhooks, Claude, etc.), not only Grok.

### Session files (Grok runner)

Written under **`~/.cyrus/logs/<workspaceName>/`** (or `$CYRUS_HOME/logs/...`):

| Pattern | Contents |
|---------|----------|
| `session-grok-<sessionId>-*.jsonl` | SDKMessage bus (what Linear activity pipeline sees) |
| `acp-wire-grok-<sessionId>-*.jsonl` | Raw ACP `session/update` payloads from Grok |

Paths are logged at INFO when a Grok session starts.

### Grok Build native sessions

`~/.grok/sessions/<url-encoded-cwd>/<sessionId>/` (e.g. `updates.jsonl`) — Grok’s own transcript. Useful when mapping looks wrong but Grok itself ran fine.

### Claude / other runners

Same `~/.cyrus/logs/` tree; Claude also writes `session-*.jsonl` / `.md`.

---

## What to attach when reporting a bug

1. `~/cyrus-debug-logs/cyrus-*.log` (full process stdout/stderr)  
2. Latest `~/.cyrus/logs/**/session-grok-*.jsonl`  
3. Matching `acp-wire-grok-*.jsonl`  
4. Optional: `~/.grok/sessions/.../updates.jsonl` for the same session id  
5. Linear issue id + how Grok was selected (label / tag / defaultRunner)  
6. `cyrus --version` / commit: `cd ~/cyrus-grok && git rev-parse --short HEAD`  

**Redact** tokens in `.env`, MCP `Authorization` headers, and auth dumps before sharing.

---

## Rollback to stock Cyrus

```bash
# Stop fork worker
pm2 stop cyrus 2>/dev/null || true

# Remove link / wrapper
npm unlink -g cyrus-ai 2>/dev/null || true
rm -f ~/.local/bin/cyrus

# Reinstall published package
npm install -g cyrus-ai@latest
hash -r
which cyrus
cyrus --version

# Restart as before
cyrus start
# or: pm2 start cyrus --name cyrus
```

`~/.cyrus` is unchanged; Linear/GitHub/Claude keep working.

---

## Update the fork later

```bash
cd ~/cyrus-grok
git fetch origin          # upstream cyrusagents (if configured)
git fetch myfork 2>/dev/null || git fetch origin
git checkout feat/grok-build-support
git pull                  # or: git pull myfork feat/grok-build-support
pnpm install
pnpm build
# restart cyrus worker
```

If the Ubuntu clone only has one remote pointing at `gautamjain/cyrus`:

```bash
git remote -v
git pull origin feat/grok-build-support
pnpm install && pnpm build
```

---

## Agent checklist (short)

```text
[ ] Stop old cyrus process
[ ] Clone gautamjain/cyrus @ feat/grok-build-support
[ ] pnpm install && pnpm build
[ ] npm link apps/cli (or PATH wrapper / node app.js)
[ ] grok login && grok models
[ ] Keep defaultRunner = Claude; use label "grok" for tests
[ ] CYRUS_LOG_LEVEL=DEBUG + tee to ~/cyrus-debug-logs/
[ ] Run one Linear issue with label grok
[ ] Collect session-grok-*.jsonl + acp-wire + terminal log if issues
```

---

## Related files in this repo

| Path | Notes |
|------|--------|
| `packages/grok-runner/README.md` | Package overview |
| `packages/grok-runner/DEBUG.md` | Shorter logging notes |
| `skills/cyrus-setup-grok-auth/SKILL.md` | Guided Grok login skill |
| `docs/SELF_HOSTING.md` | General self-host + Grok auth blurb |

---

## Delete before upstream PR

```bash
git rm FORK_DEVELOPMENT.md
# optionally also packages/grok-runner/DEBUG.md if you want a cleaner PR
git commit -m "chore: remove fork-only development docs before upstream PR"
```
