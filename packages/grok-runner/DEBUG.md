# Debugging Grok + Cyrus (fork trial)

## What gets logged

### Console (all of Cyrus)

Controlled by **`CYRUS_LOG_LEVEL`**:

| Level | What you see |
|-------|----------------|
| `DEBUG` | EdgeWorker webhooks, runner selection, Grok ACP steps, MCP list, stderr from `grok` |
| `INFO` (default) | Auth, session id, log file paths, prompt finished |
| `WARN` / `ERROR` | Failures, resume fallbacks |

Format:

```text
2026-07-22T21:00:00.000Z [INFO ] [GrokRunner] Authenticated via cached_token (SuperGrok Heavy)
2026-07-22T21:00:00.000Z [DEBUG] [EdgeWorker] ...
```

### Session files (per Grok run)

Under **`~/.cyrus/logs/<workspaceName>/`** (or `$CYRUS_HOME/logs/...`):

| File | Contents |
|------|----------|
| `session-grok-<sessionId>-<ts>.jsonl` | SDKMessage bus (what Linear’s pipeline sees): init, tool_use, tool_result, result |
| `acp-wire-grok-<sessionId>-<ts>.jsonl` | Raw ACP `session/update` payloads from Grok |

Claude uses the same logs directory with `session-*.jsonl` / `.md`.

### Grok’s own sessions

`~/.grok/sessions/<encoded-cwd>/<sessionId>/` — Grok Build native transcripts (`updates.jsonl`). Useful if ACP mapping looks wrong but Grok itself ran fine.

---

## Run the fork in debug mode

From the monorepo root (`/Users/gj/Projects/cyrus-grok`):

```bash
# 1. Build workspace
pnpm install
pnpm build

# 2. Optional: put local CLI first on PATH without publishing
pnpm --filter cyrus-ai exec which node   # sanity
# Run via node on the built CLI (recommended for fork trials):
export CYRUS_LOG_LEVEL=DEBUG
export CYRUS_DEFAULT_RUNNER=grok   # or set defaultRunner in config.json

# Capture everything for issue reports
mkdir -p ~/cyrus-debug-logs
pnpm --filter cyrus-ai start 2>&1 | tee ~/cyrus-debug-logs/cyrus-$(date +%Y%m%d-%H%M%S).log
```

Or with `node` directly after build:

```bash
export CYRUS_LOG_LEVEL=DEBUG
node apps/cli/dist/src/app.js start 2>&1 | tee ~/cyrus-debug-logs/cyrus-run.log
```

**Do not** `npm install -g` a published package if you want this fork — run from the built monorepo (or `pnpm link` the local `cyrus-ai` package).

### Env checklist

```bash
# In ~/.cyrus/.env or shell:
CYRUS_LOG_LEVEL=DEBUG
CYRUS_DEFAULT_RUNNER=grok

# Grok subscription: use `grok login` (no XAI_API_KEY needed)
# Optional: CYRUS_HOME=/path/to/custom/.cyrus
```

### After a bad run — attach these

1. Terminal log: `~/cyrus-debug-logs/cyrus-*.log`  
2. Latest under `~/.cyrus/logs/**/session-grok-*.jsonl`  
3. Matching `acp-wire-grok-*.jsonl`  
4. Optional: `~/.grok/sessions/.../updates.jsonl` for the same session id  
5. Issue identifier + whether label was `grok` / `[agent=grok]`

Redact tokens from `.env` / MCP headers before sharing.

---

## Why this helps

| Artifact | Answers |
|----------|---------|
| Console DEBUG | Webhook → runner selection → workspace → Grok start/resume |
| `session-grok-*.jsonl` | Did we emit correct tool_use / result for Linear? |
| `acp-wire-*.jsonl` | Did Grok send the update and we mis-mapped it? |
| `~/.grok/sessions` | Did Grok itself fail or succeed? |
