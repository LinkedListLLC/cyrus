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
   ```
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

## Customizing behavior & skills

- **Tools:** per-repo `allowedTools` in `config.json` (`readOnly` / `safe` / `all`
  or a custom array). See `docs/CONFIG_FILE.md`.
- **Modes:** `labelPrompts` routes Linear labels → `debugger` / `builder` / `scoper`.
- **Skills:** drop skill folders in `/root/.cyrus/` (instance-level) or a repo's
  `.claude/skills/` (per-repo); they can be scoped by repo/team/label.
- To run a **second agent** (e.g. a read-only reviewer), create a second OAuth app
  + a second Dokploy Application with its own volume and `allowedTools: readOnly`.

## Local build check

```bash
docker build -t cyrus .
```
Building the whole monorepo from source takes a few minutes.
