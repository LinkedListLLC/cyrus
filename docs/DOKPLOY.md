# Deploying Cyrus on Dokploy

This fork adds a `Dockerfile`, `docker-entrypoint.sh`, and `.dockerignore` so
Cyrus can run as a single **Dokploy Application** (Dockerfile build type). It
builds Cyrus **from source** (this is a fork you can customize), installs the
runtime deps (`git`, `jq`, `gh` with the `gh-stack` extension, the Claude Code
CLI), and runs the CLI server on port **3456**.

> Upstream Cyrus ships no container support and expects a Node process under
> pm2/systemd with state in `~/.cyrus/`. These files package that for Dokploy.

## Where config, secrets, and state go (the important part)

| Thing | How it's passed | Why |
|---|---|---|
| **Env vars / secrets** (`LINEAR_*`, `ANTHROPIC_API_KEY`, `CYRUS_BASE_URL`, `GH_TOKEN`, …) | Dokploy **Environment** panel | Cyrus reads `process.env` directly — the env page is enough. **No `.env` file mount needed.** |
| **State**: Linear OAuth token (in `config.json` → `linearWorkspaces`), cloned repos, worktrees, deployed skills | A named **Volume Mount** at `/root/.cyrus` | Any non-mounted path is **wiped on every redeploy**. This mount is **required**. |
| **`config.json`** (repos, routing, `allowedTools`, modes) | Created inside the volume by `cyrus self-add-repo`, then editable there (hot-reloaded) | Cyrus *writes* to `config.json`, so a File Mount (single-file, read-mostly) is the wrong tool — use the volume. |
| **Claude conversation transcripts** (what a session needs to resume) | `CLAUDE_CONFIG_DIR=/root/.cyrus/claude`, set in the Dockerfile | Claude Code defaults to `/root/.claude`, outside the volume. See below. |

**You do not need Dokploy's File Mount feature.** Environment panel + one volume covers everything.

### Why `CLAUDE_CONFIG_DIR` points into the volume

Claude Code stores every conversation at
`<config-dir>/projects/<sanitized-cwd>/<session-id>.jsonl`. Cyrus resumes a
Linear session by passing that session ID back to the CLI.

The two halves used to live in different places: Cyrus kept the session ID in
the volume, while Claude kept the transcript on the ephemeral layer. A redeploy
deleted the transcripts but not the IDs, so afterwards Cyrus asked for
conversations the CLI could no longer find. Every Linear session open at the
time of the redeploy failed with `No conversation found with session ID` and
could never answer again ([CYR-53](https://linear.app/linkedlist/issue/CYR-53)).

Pointing `CLAUDE_CONFIG_DIR` into the volume keeps both halves together. It
moves the whole store, including the top-level `.claude.json` that otherwise
sits beside the directory. Worktrees are already in the volume at
`/root/.cyrus/worktrees`, so the paths that key each project directory stay the
same across redeploys and the lookup still matches.

Notes:

- **Auth is unaffected.** Sessions authenticate from `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` in the Environment panel, not from the config
  directory.
- **Do not put a `settings.json` in there.** Sessions load user-scope settings,
  and its permission `allow` rules take effect before Cyrus approves a tool —
  so it can widen a session Cyrus meant to keep narrow, such as a read-only PR
  reviewer. Nothing in Cyrus writes this file. The entrypoint warns if one
  appears.
- **The first redeploy after adopting this still loses in-flight
  conversations**, because nothing migrates the old ephemeral copy. Those
  sessions restart with the full issue context instead of dead-ending.
- **Transcripts accumulate in the volume.** Claude Code prunes old ones on its
  own schedule, which is one reason Cyrus still recovers from a missing
  conversation rather than relying on the store always being there.

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

#### Pushing a change that touches `.github/workflows/`

GitHub refuses a push over **HTTPS** when the token has no `workflow` scope:

```
refusing to allow an OAuth App to create or update workflow
.github/workflows/ci.yml without `workflow` scope
```

This rule applies to OAuth tokens. It does not apply to **SSH keys**. GitHub
accepts the same push over SSH. You do not change a scope, and you do not run
`gh auth refresh`:

```bash
git push git@github.com:LinkedListLLC/cyrus.git <branch>
```

SSH is a workaround for a person, but not for Cyrus. The GitHub App
authenticates with a token, so GitHub applies the OAuth rule to it. Give the App
the **Workflows: Read and write** permission if agents must edit CI.

#### What the agent sessions can see

Scope the token as if the agent can read it, because it can.

- **`GITHUB_TOKEN` is exported into the environment** the agent sessions inherit,
  because that is how `gh` and Cyrus's GitHub-App fallback consume it. A session
  with `Bash` can therefore read the token. There is no way around this while
  `gh` is the PR mechanism.
- **The git URL rewrite is *not* written to `/root/.gitconfig`.** It goes to
  `$GIT_CONFIG_GLOBAL` (default `/run/cyrus-git/config`, mode 0600) — outside
  the `$HOME` every session runs under, and outside the persisted volume, so the
  PAT is not left on disk in a place a session reads by default.
- **Everything in the container runs as `root`, including agent sessions.** This
  image is single-tenant by design — one operator, one workspace — and the
  processes it runs are the agent sessions themselves, so a non-root user would
  buy little while breaking the `/root/.cyrus` volume layout every path here
  assumes. The consequence is worth stating plainly: the per-session tool
  restrictions are Claude Code's permission layer, not an OS boundary. If you
  want an OS boundary, enable the sandbox (see *Sandbox*, below) — that is what
  enforces filesystem limits at the kernel level.

Practical upshot: use a **fine-grained PAT scoped to the specific repos**, never
a classic `repo`-scoped token on an account with access to anything you would
mind an agent session reaching.

### GitHub App (recommended): give Cyrus its own identity

A personal access token makes Cyrus **you** on GitHub. Every pull request Cyrus
opens is authored by the account that owns the token. GitHub does not let a
person approve their own pull request, and it never notifies a person about
their own pull request. So the owner of the token can neither approve the work
nor learn that it is ready.

A GitHub App fixes both. Pull requests then come from `<app-slug>[bot]`, and
every human on the team is a third party who can approve them. An App costs no
GitHub seat, and its token is scoped per repository instead of carrying one
person's whole account.

#### Create and install the App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** in the
   organization that owns the repositories.
2. Give it a name. The URL slug that GitHub derives from the name becomes the
   bot login, for example `cyrus-linkedlist` → `cyrus-linkedlist[bot]`.
3. **Webhook**: set the URL to `https://cyrus.<your-domain>/github-webhook` and
   set the secret to the value you put in `GITHUB_WEBHOOK_SECRET`. This also
   turns on the pull-request comment loop, so Cyrus answers `@` mentions on its
   own pull requests. Clear the **Active** box if you do not want that loop.
4. **Repository permissions**:

   | Permission | Level | Why |
   |---|---|---|
   | **Contents** | Read and write | Clone the repository and push the branch |
   | **Pull requests** | Read and write | `gh pr create`, and the reviewer request |
   | **Issues** | Read and write | Comment on issues, and read issue comments |
   | **Metadata** | Read | Mandatory baseline (selected automatically) |
   | **Workflows** | Read and write *(optional)* | Only if agents may edit `.github/workflows/**` |

5. **Generate a private key**. GitHub downloads a `.pem` file once. Keep it.
6. **Install the App** on the repositories Cyrus works in. The installation ID
   is the last number in the URL of the installation settings page:
   `https://github.com/organizations/<org>/settings/installations/<installation-id>`.

#### Put the private key in the volume

The key goes at `/root/.cyrus/github-app.pem`, inside the `cyrus-data` volume,
so it survives a redeploy. Open the Application's **Terminal** in Dokploy and
paste the file:

```bash
cat > /root/.cyrus/github-app.pem <<'PEM'
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
PEM
chmod 600 /root/.cyrus/github-app.pem
```

#### Environment variables

```env
GITHUB_APP_ID=<app id>                    # "App ID" on the App's General page
GITHUB_APP_INSTALLATION_ID=<installation id>
GITHUB_APP_SLUG=<url slug>                # optional, but see below
GITHUB_APP_NAME=<display name>            # optional, defaults to <slug>[bot]
GITHUB_BOT_USERNAME=<mention handle>      # optional, see "Which handle to mention"
```

`GITHUB_APP_SLUG` is optional and sets the **commit** author. Without it
the pull request still comes from the bot, but the commits inside it keep the
default git identity. With it, the entrypoint reads the bot's numeric user ID
from the public GitHub API and uses
`<bot-user-id>+<slug>[bot]@users.noreply.github.com`, which is how GitHub links
a commit to the bot account. A failed lookup only prints a warning.

The entrypoint sets that identity **twice**: in the git config, and as
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` in the environment. The second is the one
that decides. The session prompt gives the agent the *assignee's* GitHub
noreply address, and agents infer from it that they should commit as that
person — observed runs did exactly that while the git config held the correct
bot identity. Git reads `GIT_AUTHOR_*` ahead of configuration, so exporting it
outranks the global file and anything a session sets with `git config` or
`git -c`. Only an explicit `git commit --author=...` beats it.

> **Attribution moves to the bot, not to nobody.** With this set, git history
> no longer records which person a change was delegated for. The Linear issue
> and the pull request still carry that, so the link is preserved — it just
> lives outside the commit. If you would rather keep it in the commit, add a
> `Co-Authored-By:` trailer in the persona prompt instead of unsetting this.

Keep `GH_TOKEN` set as well if you want a fallback: Cyrus uses it only when it
cannot mint an App token, and it says so in the log when it does.

#### Which handle to mention

Every pull request that Cyrus opens ends with a tip that names the handle to
@mention to reach the agent. The handle belongs to the App, so Cyrus reads it
from the deployment. It uses the first of these that it finds:

1. `GITHUB_BOT_USERNAME`.
2. `GITHUB_APP_SLUG`.
3. The App's own slug, read from the GitHub API at start-up.

Set nothing and the third source applies, which is correct for most
deployments. Set `GITHUB_BOT_USERNAME` only when the handle people type is not
the App slug. GitHub autocompletes real user accounts only, so teams that want
autocomplete register a user account and point mentions at it. That name can
differ from the slug.

`GITHUB_BOT_USERNAME` does one more thing: it limits which pull-request
comments wake Cyrus to the comments that @mention it. The other two sources do
not. Leave it unset and Cyrus reads every comment on its pull requests.

#### How the token reaches git and gh

An App installation token expires **one hour** after it is minted, and agent
sessions frequently run for longer than that. A token injected once, at
container boot, would already be dead by the time the session opens its pull
request. The image therefore mints a token on demand:

- `cyrus github-token` prints a valid token. It caches the token at
  `/root/.cyrus/github-token.json` (mode `0600`) and mints a new one when less
  than 5 minutes of life remain.
- `/usr/local/bin/gh` is a wrapper that calls `cyrus github-token` and then runs
  the real GitHub CLI, which the image keeps at `/usr/local/bin/gh-real`.
- A git credential helper calls the same command, so `git push` and `git fetch`
  also get a fresh token.

In App mode the entrypoint does **not** install the `url.insteadOf` rewrite that
the personal-access-token mode uses. That rewrite embeds one fixed token in
every remote URL, which would both pin a credential that dies after an hour and
stop git from consulting the credential helper.

With `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` unset, none of the above
runs and the personal-access-token behaviour is unchanged.

### Reviewer routing: tell the delegating user the work is ready

A bot author lets everyone approve, but it notifies nobody. GitHub sends a
notification only when a review is **requested**. Cyrus knows the Linear ID and
the email of the person who delegated the issue, but GitHub needs a GitHub
handle, and no automatic link exists between the two.

Add a `reviewers` map to a repository in `/root/.cyrus/config.json`:

```json
{
  "id": "job-boards",
  "reviewers": [
    { "email": "rayan@example.com", "github": "rayan-gh" },
    { "id": "usr_abc123", "github": "whollacsek" }
  ]
}
```

Each entry identifies the user the same way the `userAccessControl` allowlist
does — by `email` or by `id` — and adds their GitHub handle. When Cyrus opens a
pull request, it requests a review from the person who delegated the issue.

A delegating user who is absent from the map only produces a log line: the pull
request opens with no reviewer, and the session continues. Cyrus never requests
the pull request author, so the bot is never asked to review itself.

#### Webhook authentication

`WEBHOOK_IP_VALIDATION=false` is baked into the image, and correctly so: behind
Traefik the source IP Cyrus sees is the proxy's edge, never Linear's, so the
allowlist would reject every delivery. That makes the **HMAC signature the only
authentication on the webhook endpoint**, which means the signing secret is
mandatory rather than optional.

Cyrus enforces that: with `LINEAR_DIRECT_WEBHOOKS=true` and no
`LINEAR_WEBHOOK_SECRET`, it now **refuses to start**. Previously the secret fell
back to an empty string, and an HMAC computed with an empty key is one any caller
can also compute — so with the IP check off, every forged webhook would have been
accepted. Set `LINEAR_WEBHOOK_SECRET` to the signing secret from Linear's webhook
settings.

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

## Optional: Grok Build as a second runner

Cyrus can run agent sessions on **Grok Build** instead of Claude Code, selected
per issue with a `grok` Linear label or an `[agent=grok]` tag in the issue
description (or globally with `"defaultRunner": "grok"` in `config.json`).

The image already ships the `grok` binary at `/usr/local/bin/grok`, so only the
one-time login is manual — it's a **browser OAuth against your Grok
subscription**, which can't be passed as an env var.

1. Add env `CYRUS_SETUP_IDLE=true` and redeploy (same idle trick as the Linear
   OAuth above), then open the Application's **Terminal**:
   ```bash
   grok login     # prints a URL — open it in your browser and approve
   grok models    # verify: should report you're logged in and list a default model
   ```
2. **Remove** `CYRUS_SETUP_IDLE` and redeploy.

**Why the login survives redeploys.** `GROK_HOME=/root/.cyrus/grok` puts the
CLI's entire home — `auth.json`, `config.toml`, `agent_id` — *inside* the
`cyrus-data` volume, and the entrypoint additionally symlinks `/root/.grok` to
the same place (the CLI's own tooling is `$HOME/.grok`-centric, Cyrus reads
`$GROK_HOME`; both now resolve to the persisted directory). Verified: with
`GROK_HOME` set, the CLI writes everything there and leaves `/root/.grok` empty.

**Notes.**
- `XAI_API_KEY` is only a headless fallback and **bills per-token via the xAI
  API** — it defeats the point of a subscription. Prefer `grok login`.
- Auto-update is disabled (`GROK_DISABLE_AUTOUPDATER=1`): the binary lives in a
  read-only image layer, so upgrades happen by rebuilding the image.
- The `grok` CLI adds ~130 MB to the image.
### Tool restrictions on Grok sessions

Cyrus's `allowedTools` / `disallowedTools` (including the `readOnly` and `safe`
presets and per-label `labelPrompts`) are now translated into **Grok permission
rules** and passed to the CLI as `--allow` / `--deny` flags.

Two things make this more than a pass-through:

- **`mcp__server` grants are rewritten.** Grok tool names carry no `mcp__`
  prefix, so a rule written `mcp__linear` matches nothing and is skipped with a
  warning — a review persona would silently lose its ability to post back to
  Linear. It becomes `MCPTool(linear__*)`.
- **Restrictions are expressed as denies.** Only `deny` is honoured in every
  permission mode; an allow-list alone would be inert under the
  `--always-approve` that unattended sessions use. So when an allow-list is in
  force, every mutating tool class missing from it (`Edit`, `Write`,
  `NotebookEdit`, `Bash`) is denied explicitly. This mirrors Grok's own
  documented read-only-reviewer example.

**Known limits, by design:**

- Tool names Grok doesn't recognize (`Task`, `Skill`, `TaskCreate`, …) have no
  equivalent and are dropped. They're logged at startup as
  *"Tool rules with no Grok equivalent (ignored): …"* rather than silently
  discarded. Grok's built-in auto-approvals still cover read-only work
  (`read_file`, `list_dir`, `grep`, `web_search`, invoking skills).
- **A scoped Bash grant can't be enforced.** `Bash(git:*)` means "only git", but
  Grok evaluates `deny` before `allow`, so a blanket `Bash` deny would kill the
  permitted git commands too. In that case Bash is left **unrestricted** and the
  session logs a warning saying so. Narrowing it needs `defaultMode: "dontAsk"`
  in `.claude/settings.json` or a `PreToolUse` hook — neither of which Cyrus
  writes into your repository worktree.

**How it is enforced (and why not by the CLI).** Live testing on CYR-9 showed
the `--deny` flags are accepted by the Grok CLI and then **ignored**: the
process carried `--deny Write`, the agent wrote a file anyway, and that
session's ACP wire log contained 746 updates and **zero**
`session/request_permission` calls. `--always-approve` short-circuits the rule
engine before deny is consulted, so the agent never asks — contrary to the
CLI's own documentation.

So Cyrus enforces the policy itself:

- when a restriction is in force it **withholds `--always-approve`**, so the
  agent asks rather than proceeding silently (unrestricted sessions keep it and
  behave exactly as before), and
- it answers each `session/request_permission` against the policy instead of
  blanket-approving. The client decides immediately, so nothing stalls waiting
  for a human.

Classification reads Grok's own tool descriptor (`_meta["x.ai/tool"]`) and ACP's
`toolCall.kind`/`title`, and **fails closed** — with a restriction in force, a
request that cannot be classified is denied. If that ever over-blocks, it shows
up loudly in the session transcript rather than silently letting a write through.

**Re-verify after any Grok CLI upgrade**, since this depends on the CLI's
permission behaviour: file an issue with a read-only label asking the agent to
attempt a file write, and confirm it is refused.

### Sandbox (optional, stronger than rules)

Grok also has a kernel-enforced sandbox (Landlock on Linux) that Cyrus does not
set. It's available via the CLI's own env var, so you can turn it on per
deployment without a code change:

```
GROK_SANDBOX=read-only     # read everywhere; writes only to ~/.grok + temp
```

⚠️ The `read-only` and `strict` profiles **block child-process network access on
Linux**, which will break stdio MCP servers that need the network (the Linear
MCP among them). For a reviewer that still has to comment on Linear, prefer the
permission rules above, or a custom profile in `sandbox.toml` with
`restrict_network = false`.

### Skills

`~/.cyrus/skills` staging is Claude/Codex-only (`runnerSupportsManagedSkills`),
so Cyrus does not install skills into a Grok session. Grok has its own skills
system, so wiring the two together is possible but is not done yet.

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
