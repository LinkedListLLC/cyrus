# Deploying Cyrus on Dokploy

This fork adds a `Dockerfile`, `docker-entrypoint.sh`, and `.dockerignore` so
Cyrus can run as a single **Dokploy Application** (Dockerfile build type). It
builds Cyrus **from source** (this is a fork you can customize), installs the
runtime deps (`git`, `jq`, `gh`, the Claude Code CLI), and runs the CLI server
on port **3456**.

> Upstream Cyrus ships no container support and expects a Node process under
> pm2/systemd with state in `~/.cyrus/`. These files package that for Dokploy.

## Where config, secrets, and state go (the important part)

| Thing | How it's passed | Why |
|---|---|---|
| **Env vars / secrets** (`LINEAR_*`, `ANTHROPIC_API_KEY`, `CYRUS_BASE_URL`, `GH_TOKEN`, …) | Dokploy **Environment** panel | Cyrus reads `process.env` directly — the env page is enough. **No `.env` file mount needed.** |
| **State**: Linear OAuth token (in `config.json` → `linearWorkspaces`), cloned repos, worktrees, deployed skills | A named **Volume Mount** at `/root/.cyrus` | Any non-mounted path is **wiped on every redeploy**. This mount is **required**. |
| **`config.json`** (repos, routing, `allowedTools`, modes) | Created inside the volume by `cyrus self-add-repo`, then editable there (hot-reloaded) | Cyrus *writes* to `config.json`, so a File Mount (single-file, read-mostly) is the wrong tool — use the volume. |

**You do not need Dokploy's File Mount feature.** Environment panel + one volume covers everything.

## One-time prerequisites

1. **DNS** — point `A cyrus.<your-domain> → <Dokploy host IP>` before creating the
   domain (Let's Encrypt needs it to resolve).
2. **Linear OAuth app** — Linear → Settings → API → OAuth applications → create one
   (name it e.g. **"Cyrus"**, give it an icon — that's the assignable agent's identity):
   - Redirect / callback URL: `https://cyrus.<your-domain>/callback`
   - Webhook URL: `https://cyrus.<your-domain>/linear-webhook`
   - Enable webhooks + the agent/assignable scopes.
   - Capture `Client ID`, `Client Secret`, and the `Webhook signing secret`.
3. **Anthropic** — an `ANTHROPIC_API_KEY` (or a `CLAUDE_CODE_OAUTH_TOKEN`).
4. **GitHub PAT** — a token for cloning repos, pushing branches, and opening PRs
   (goes in the `GH_TOKEN` env var). Exact permissions below.

### GitHub token permissions (`GH_TOKEN`)

Cyrus does three things on GitHub: **clone the repo, push the per-issue branch,
and open a PR.** The token is used both by git (URL rewrite in the entrypoint)
and the `gh` CLI (exported as `GITHUB_TOKEN`), so one token covers both.

**Fine-grained PAT (recommended):**
- **Resource owner:** the org that owns the repos (e.g. `LinkedListLLC`), *not*
  your personal account. If the org requires approval for fine-grained PATs,
  approve the request.
- **Repository access:** select the specific repos Cyrus will work in (or "All
  repositories" under the org).
- **Repository permissions:**

  | Permission | Level | Why |
  |---|---|---|
  | **Contents** | Read and write | Clone + push the branch |
  | **Pull requests** | Read and write | `gh pr create` + update PRs |
  | **Metadata** | Read | Mandatory baseline (auto-selected) |
  | **Workflows** | Read and write *(optional)* | Only if agents may edit `.github/workflows/**` — without it, any push touching a CI file is rejected |
  | **Issues** | Read and write *(optional)* | Only if you wire GitHub Issues as a trigger source or want it commenting on GH issues |

  The first three are the required core; add **Workflows** if coding tasks might touch CI config.

**Classic PAT (simpler, broader):** scope `repo` (full private-repo control)
covers clone/push/PR; add `workflow` if touching workflow files, `read:org` if
you hit org-visibility issues.

## Create the Dokploy Application

1. **New Application** → Source: GitHub `LinkedListLLC/cyrus`, branch `main`.
2. **Build Type: Dockerfile** — Dockerfile Path `Dockerfile`, Context Path `.`.
3. **Environment** panel:
   ```env
   LINEAR_DIRECT_WEBHOOKS=true
   LINEAR_CLIENT_ID=<client id>
   LINEAR_CLIENT_SECRET=<client secret>
   LINEAR_WEBHOOK_SECRET=<webhook signing secret>
   CYRUS_BASE_URL=https://cyrus.<your-domain>
   CYRUS_HOST_EXTERNAL=true
   ANTHROPIC_API_KEY=<anthropic key>      # or CLAUDE_CODE_OAUTH_TOKEN
   GH_TOKEN=<github fine-grained PAT>
   # CYRUS_SERVER_PORT defaults to 3456 (already set in the image)
   # WEBHOOK_IP_VALIDATION defaults to false in the image — see note below
   ```

   > **Webhook IP validation.** `CYRUS_HOST_EXTERNAL=true` (needed so the server
   > binds `0.0.0.0` for Traefik) makes Cyrus auto-enable a source-IP allowlist
   > that only trusts Linear's GCP webhook IPs. Behind Traefik/Cloudflare the
   > source IP is the proxy's edge, so every webhook is rejected
   > (`Rejected Linear webhook from unauthorized IP …`). The image therefore
   > ships `WEBHOOK_IP_VALIDATION=false`; the `LINEAR_WEBHOOK_SECRET` HMAC
   > signature still authenticates every webhook. Only set it back to `true` if
   > you expose the container directly with no proxy (and, if using Cloudflare,
   > set the DNS record to "DNS only" so Linear's real IP reaches Cyrus).
4. **Mounts → add Volume Mount:** Volume Name `cyrus-data`, Mount Path `/root/.cyrus`.
5. **Domains → add:** Host `cyrus.<your-domain>`, Container Port `3456`, HTTPS on,
   Certificate `letsencrypt`. (No host port mapping needed — Traefik reaches the
   container over the internal network; the image binds `0.0.0.0:3456` via
   `CYRUS_HOST_EXTERNAL=true`.)
6. **Deploy.**

## One-time interactive setup (Linear OAuth)

The Linear OAuth token can't be passed as an env var — it must be written into
`/root/.cyrus/config.json`. Do it once; it then persists in the `cyrus-data`
volume across redeploys.

1. Add env `CYRUS_SETUP_IDLE=true` and redeploy. The container stays up but does
   **not** start the server (so the OAuth callback server can bind `:3456`).
2. Open the Application's **Terminal** in Dokploy and run:
   ```bash
   # The entrypoint auto-seeds /root/.cyrus/config.json. If you're on an older
   # image and `self-auth-linear` says "Config file not found", create it once:
   #   mkdir -p /root/.cyrus && echo '{"repositories": []}' > /root/.cyrus/config.json
   cyrus self-auth-linear
   # → prints an authorization URL. Open it in your browser, approve.
   #   Linear redirects to https://cyrus.<your-domain>/callback and the token is
   #   saved into /root/.cyrus/config.json (the volume).

   cyrus self-add-repo https://github.com/LinkedListLLC/<repo>.git "LinkedList"
   # → clones the repo into the volume and writes its entry into config.json.
   ```
3. **Remove** `CYRUS_SETUP_IDLE` and redeploy. Cyrus boots with the token + repo
   already present and starts serving webhooks.

## Verify

- Container logs show the server listening on `0.0.0.0:3456`.
- `https://cyrus.<your-domain>/linear-webhook` responds over HTTPS with a valid cert.
- In Linear, **assign an issue to the Cyrus agent** → it should create a worktree,
  run a Claude Code session, comment progress, and open a PR.
- Redeploy once and confirm the added repo/token survive (proves the volume works).

## Routing issues to the right repo (avoid the "which repo?" prompt)

When more than one repo is configured, Cyrus matches each assigned issue to a
repo using `config.json` routing keys, in strict priority (falling through if
none match):

1. description tag in the issue body →
2. **`routingLabels`** — Linear label names (exact) →
3. **`projectKeys`** — Linear project names →
4. **`teamKeys`** — Linear team keys (exact, case-sensitive; e.g. `JOB` for `JOB-165`) →
5. issue-identifier prefix (also matched against `teamKeys`) →
6. a single **catch-all** repo (one with *no* teamKeys/routingLabels/projectKeys) →
7. otherwise Cyrus **asks** you to pick.

`cyrus self-add-repo` defaults each repo's `routingLabels` to its repo name, so
if your issues don't carry a label of that name, nothing matches and you get the
prompt. The fix is to add **`teamKeys`** so issues route by their team:

```bash
cd /root/.cyrus && cp config.json config.json.bak && \
jq '.repositories |= map(
      if   .name == "job-boards" then . + {teamKeys: ["JOB"]}
      elif .name == "SalonPrive" then . + {teamKeys: ["SP"]}
      else . end)' config.json.bak > config.json
```

`config.json` is hot-reloaded (watch for `🔄 Config file changed, reloading…`);
no redeploy needed. Because `routingLabels` outrank `teamKeys`, you can also keep
a repo label-routed (tag the issue) as a manual override for a specific repo.

## Customizing agent behavior

Everything below is per-repo in `config.json` (hot-reloaded — no redeploy),
except the file/skill edits. Ranked easiest → most powerful:

1. **`appendInstruction`** (string) — free-text guidance appended to every session
   for that repo, wrapped in `<repository-specific-instruction>`. The quickest way
   to add house rules or a persona nudge without touching prompt files.
   ```json
   "appendInstruction": "Use conventional commits. Run `pnpm test` before opening a PR. Prefer small, reviewable diffs."
   ```
2. **`CLAUDE.md`** in the target repo — Claude Code reads it natively.
3. **`labelPrompts`** — map Linear **labels → a mode**, each with its own persona
   prompt + tool policy. Modes (0.2.66): `builder` (implement), `debugger` (fix),
   `scoper` (analysis/spec), `orchestrator` (decompose + coordinate sub-agents),
   `graphite` / `graphite-orchestrator` (stacked PRs). **Not deprecated — actively
   used.** Matching is case-insensitive on label names.
   ```json
   "labelPrompts": {
     "builder":  { "labels": ["Feature","Improvement"], "allowedTools": "safe" },
     "debugger": { "labels": ["Bug"], "allowedTools": "readOnly" },
     "scoper":   { "labels": ["PRD","Spec"] }
   }
   ```
4. **Skills** — reusable, runtime-discoverable procedures (v0.2.41+ replaced the old
   hardcoded procedure sequences; they did **not** replace `labelPrompts`). Two homes:
   - **`<repo>/.claude/skills/*`** — auto-discovered whenever Cyrus works in that repo
     and **always loaded** (no per-label filtering; presence in the repo is the scope).
   - **`~/.cyrus/skills/*`** (instance-wide) — supports a **`scope.json`** sidecar
     (`repositoryIds` / `linearTeamIds` / `linearLabelIds` — note: label **IDs**, not
     names) to load a skill only for matching sessions.
5. **`promptTemplatePath`** (string) — replace the default prompt scaffold for the repo.
6. **Fork superpower (build-from-source):** edit the mode prompts directly —
   `packages/edge-worker/prompts/{builder,debugger,scoper,orchestrator}.md`
   (versioned with `<version-tag>`).
7. **Capabilities:** `allowedTools` / `disallowedTools` (per repo), `promptDefaults`
   (global per-mode tools), `model` / `fallbackModel` (or Linear model labels like
   `opus`, `fable`, `sonnet`, `gpt-5.5`, `*-codex`), `mcpConfigPath` (add MCP tools).

To run a **second agent** (e.g. a read-only reviewer): second OAuth app + second
Dokploy Application with its own volume, `allowedTools: readOnly`, and an
`appendInstruction` describing the review job.

### Example: routing a planning workflow by label

If your issues use a labelled planning workflow (e.g. wayfinder's `wayfinder:*`
labels), map each label to a persona + tool policy with `labelPrompts` and steer
the behavior with `appendInstruction`. AFK ticket types (research/task) run fully
autonomously; HITL types (grilling/prototype) work via async Q&A in the Linear
thread (Cyrus asks, you reply, it continues) — give those `readOnly` so they can't
drift into implementing:

```json
"labelPrompts": {
  "scoper":       { "labels": ["wayfinder:research", "wayfinder:grilling"], "allowedTools": "readOnly" },
  "builder":      { "labels": ["wayfinder:task", "wayfinder:prototype"], "allowedTools": "safe" },
  "orchestrator": { "labels": ["wayfinder:map"] }
},
"appendInstruction": "If this issue has a `wayfinder:<type>` label, follow the matching skill: research → read + post findings (don't implement); task → do the unblocking work and record resulting facts; prototype → build a cheap throwaway, link it, ask for reaction; grilling → HITL, ask ONE question at a time in the thread and WAIT (never answer your own questions). Prefer decisions over deliverables."
```

The skills these reference (`research`, `prototype`, `grilling`, …) are picked up
automatically from the repo's committed `.claude/skills/` — no install needed.

## Local build check

```bash
docker build -t cyrus .
```
Building the whole monorepo from source takes a few minutes.
