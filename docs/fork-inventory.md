# Fork inventory and clean-branch plan

**Issue:** [CYR-48](https://linear.app/linkedlist/issue/CYR-48)
**Written:** 2026-07-28
**Status:** proposal. Do not open the clean PR before William approves this document.

## 1. The fork point

| Item | Value |
| -- | -- |
| Upstream | `ceedaragents/cyrus` (`upstream/main`) |
| Fork | `LinkedListLLC/cyrus` (`origin/main`) |
| Fork point (merge base) | `516d8a03` — "Patch Cyrus CLI security advisories (#1383)", 2026-07-23 |
| Our commits after it | 45, all linear. No merge commits. |
| Upstream commits after it | 3 |
| Net change | 132 files, +16653 / −584 |

Command that finds it again:

```bash
git merge-base origin/main upstream/main    # 516d8a033647612d5e7dd2ff88cc7f1951d7eac2
```

## 2. Baseline of the current fork tip

Measured on `166368dc` before any rework:

| Check | Result |
| -- | -- |
| `pnpm build` | pass |
| `pnpm typecheck` | pass |
| `pnpm test:packages:run` | pass |
| edge-worker | 898 tests, 76 files |
| core | 150 tests |
| claude-runner | 166 tests, 5 skipped (live SDK, opt-in) |
| grok-runner | 103 tests |
| apps/cli | 127 tests |

The clean branch must hold this baseline. Use it as the acceptance gate.

## 3. Upstream movement since the fork point

| Commit | Subject |
| -- | -- |
| `7ed4ec7b` | fix(codex): bump bundled runtime for GPT-5.6 (#1372) |
| `e7e0aadd` | Use Linear manifest for setup app creation (#1385) |
| `d1a98b80` | Release v0.2.67 (#1386) |

Upstream supplies nothing that our fork also built. No feature below becomes obsolete.

Only six files changed on both sides:

```
CHANGELOG.md                                 <- the one real conflict
packages/claude-runner/package.json          auto-merges
packages/core/package.json                   auto-merges
packages/edge-worker/package.json            auto-merges
packages/simple-agent-runner/package.json    auto-merges
pnpm-lock.yaml                               auto-merges
```

A `git merge-tree` probe gives one content conflict: `CHANGELOG.md`. The package
files auto-merge because the version line and the SDK line are far apart. **Check
the result by hand:** the clean branch must keep our `@anthropic-ai/claude-agent-sdk`
`0.3.220` and take upstream's package version `0.2.67`.

## 4. Feature inventory

Nineteen features. The 45 commits map onto them with no remainder.

### F1 — Self-host Docker image and Dokploy runbook

* **Purpose:** build and run this fork as a headless container on Dokploy.
* **Commits:** `1f919524`, `4bfb26f1`, `4b848f68`, `a6223e48`, `e8dc8cc4`, `af55a26c`, `3c7e9ea4` (7)
* **Files:** `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore`, `.gitignore`, `docs/DOKPLOY.md`
* **Tests:** none. CI never builds the image. See risk R4.
* **Recommendation: keep.** Squash the seven commits into one. Six of them are
  doc additions to the same file, written as the deploy was debugged.
* **Notes:** `4b848f68` seeds `config.json` because `cyrus self-auth-linear`
  fails without it. That is an upstream usability defect — see U3.

### F2 — Webhook IP allowlist off by default in the image

* **Purpose:** accept Linear webhooks behind Traefik and Cloudflare.
* **Commits:** `c3f399dd` (1)
* **Files:** `Dockerfile`, `docs/DOKPLOY.md`
* **Tests:** none.
* **Recommendation: keep, but review as a security change, not as deploy config.**
  `CYRUS_HOST_EXTERNAL=true` auto-enables a source-IP allowlist that trusts
  Linear's GCP addresses. Behind a proxy the source IP is the proxy edge, so
  every webhook is rejected. The commit sets `WEBHOOK_IP_VALIDATION=false` in the
  image and relies on the `LINEAR_WEBHOOK_SECRET` HMAC signature alone.
  That reasoning is sound, but it removes a defence layer. Give it its own
  commit so it is visible in review, not buried in the Dockerfile commit.

### F3 — Planning skills pack

* **Purpose:** dogfood Wayfinder planning skills on the fork.
* **Commits:** `a28d659b`, `d06ba5f4`, `166368dc` (3)
* **Files:** `.agents/skills/**` (wayfinder, research, grilling, prototype, domain-modeling, handoff, adhd), `.claude/skills/*` symlinks, `skills-lock.json`, `docs/agents/issue-tracker.md`, `CLAUDE.md`
* **Tests:** not applicable.
* **Recommendation: keep.** Squash into one commit.

### F4 — Simplified Technical English mandate

* **Purpose:** hold user-facing output to ASD-STE100.
* **Commits:** `a8982375` (1)
* **Files:** `CLAUDE.md`
* **Tests:** not applicable.
* **Recommendation: keep.** Fold into F3.

### F5 — Grok Build runner over ACP

* **Purpose:** add xAI Grok Build as a Cyrus agent runner.
* **Commits:** `3b1bcdc2`, `36c68472`, `16b14b49` (3)
* **Files:** `packages/grok-runner/**` (new package), `RunnerSelectionService.ts`, `EdgeWorker.ts`, `ConfigManager.ts`, `AgentSessionManager.ts`, `ChatSessionHandler.ts`, `RunnerConfigBuilder.ts`, `core/config-schemas.ts`, `core/CyrusAgentSession.ts`, `tsconfig.base.json`, `skills/cyrus-setup-grok-auth/SKILL.md`, `FORK_DEVELOPMENT.md`
* **Tests:** 103 in `packages/grok-runner/test/` (shared with F6/F7).
* **Recommendation: keep.** Fold `16b14b49` (review fixes) into the feature
  commit. Author is Gautam Jain — preserve authorship on the rebuilt commit.
* **Notes:** this is the largest single addition. It follows the harness
  checklist in `CLAUDE.md`.

### F6 — Grok tool-policy enforcement

* **Purpose:** make Cyrus tool restrictions bite on the Grok path.
* **Commits:** `0c4da4e8`, `8b1eff1f`, `dde6f917`, `5ecb4482` (4)
* **Files:** `grok-runner/src/toolPolicy.ts`, `GrokRunner.ts`, `backend/AcpClient.ts`, `index.ts`
* **Tests:** `toolPolicy.test.ts`, `permissionEnforcement.test.ts`
* **Recommendation: keep, but rebuild as one commit at the final design.**
* **This chain reverses itself twice. Do not replay it.** The steps were:
  1. `0c4da4e8` translated Cyrus restrictions into Grok CLI permission rules.
  2. `8b1eff1f` found the CLI accepts those rules and ignores them —
     `--always-approve` short-circuits the rule engine. Enforcement moved
     client-side, into the ACP `onAgentRequest` hook.
  3. `dde6f917` found a scoped `Bash` grant permitted every command.
  4. `5ecb4482` found the grant matcher matched nothing at all, because a `*`
     in the middle of a pattern stayed a literal asterisk — and that prefix
     matching on a raw shell string was bypassable by chaining.
* **The final design only:** withhold `--always-approve` when a restriction is
  in force; answer permission requests from the policy client-side; compile
  grants to an anchored regex; tokenise the command and check every segment;
  fail closed on anything unparseable.

### F7 — Grok denial continuation and audit

* **Purpose:** let a session finish and report after the policy refuses a tool.
* **Commits:** `1b6e5c6f`, `f4c4b658` (2)
* **Files:** `GrokRunner.ts`, `GrokEventMapper.ts`
* **Tests:** `denialContinuation.test.ts`
* **Recommendation: keep.** One commit. Depends on F6.

### F8 — Shared shell-command policy in `cyrus-core`

* **Purpose:** one engine-agnostic shell matcher for both runners.
* **Commits:** carried inside `b9ff6131` (1, shared with F10)
* **Files:** `packages/core/src/shell-command-policy.ts` (230 lines, new)
* **Tests:** covered through the two runners' suites.
* **Recommendation: keep, and land it first.** In our history this file was
  written inside `grok-runner`, then moved to `cyrus-core` when
  `claude-runner` needed it and could not depend on `grok-runner`. The clean
  branch should put it in `cyrus-core` from the start. That removes a move
  and a re-export from the diff.

### F9 — Reachable platform-default `allowedTools` (CYR-28)

* **Purpose:** stop sessions resolving to an empty tool list.
* **Commits:** `8ff26f3e`, `38673e59` (2)
* **Files:** `apps/cli/src/services/WorkerService.ts`, `ToolPermissionResolver.ts`, `docs/upstream/allowed-tools-fallback-unreachable.md`
* **Tests:** `WorkerService.tool-permissions.test.ts` (15), `ToolPermissionResolver.allowed-tools-fallback.test.ts` (22)
* **Recommendation: keep, and land it before F10.** This is an **upstream**
  bug: the CLI turned "not configured" into `[]`, and `[]` is truthy, so the
  resolver's platform-default rung was dead code. It was harmless upstream and
  became severe once F10 derived real tool grants from that list. Landing it
  first means the clean branch never contains the broken combination.
* **See U1** — candidate to send upstream.

### F10 — Claude read-only sessions and enforced Bash grants

* **Purpose:** make `allowedTools` restrict rather than only auto-approve.
* **Commits:** `119e3cf1`, `675aa1ce`, `b9ff6131`, `befb3ddc`, `742e2f3b` (5)
* **Files:** `claude-runner/src/built-in-tool-restrictions.ts` (new), `ClaudeRunner.ts`, `core/allowed-tools-defaults.ts`
* **Tests:** `built-in-tool-restrictions.test.ts`, `scoped-bash-enforcement.test.ts`
* **Recommendation: keep, but rebuild as one commit at the final design.**
* **This chain reverses itself once.** `119e3cf1` derived the SDK `tools`
  option from `allowedTools` and **withheld** narrowed Bash grants, because a
  grant pattern auto-approves and can never deny. That silently left review
  personas with no shell: the reviewer read files at the PR head with no way
  to see the diff, and still posted a verdict. `b9ff6131` reversed it —
  narrowed grants are now **enforced** through `canUseTool` against the shared
  matcher in F8.
* **The final design only:** grant `Bash` for narrowed entries, enforce every
  command through `canUseTool`, strip Bash from the SDK `allowedTools` so
  nothing is auto-approved ahead of the callback, and keep failing closed on
  `Edit`/`Write`/`NotebookEdit` path narrowing.
* **Changelog consequence:** the CYR-15 entry saying Slack sessions lost their
  shell is false at the final state. See D3.

### F11 — `disallowedTools` deny layer (CYR-25)

* **Purpose:** add a deny layer that survives pre-approval and settings shadowing.
* **Commits:** `339d1477`, `14804f1d`, `730731e8` (3)
* **Files:** `ClaudeRunner.ts`, `built-in-tool-restrictions.ts`, `ToolPermissionResolver.ts`, `core/allowed-tools-defaults.ts`, `grok-runner/src/toolPolicy.ts`
* **Tests:** `derived-disallowed-tools.test.ts`, `live-sdk-precedence.test.ts` (opt-in, `CYRUS_LIVE_SDK_TEST=1`), `ToolPermissionResolver.disallowed-tools-ladder.test.ts`, `cross-runner-tool-policy.test.ts`
* **Recommendation: keep.** One commit, with `730731e8` folded in.
* **`730731e8` is a correction, not a feature.** `339d1477` credited
  `sandbox.autoAllowBashIfSandboxed` for the read-only pre-approval.
  Re-measurement showed the pre-approval fires with no `sandbox` key at all,
  so it is a read-only command classifier inside Claude Code and the sandbox
  flag is irrelevant. **Write the corrected attribution into the rebuilt
  commit and its source comments.** Do not carry the wrong claim and then fix it.
* **Also inside `339d1477`:** a real Grok fix — `evaluatePermissionRequest`
  read a scoped `Bash(sed:*)` deny as a blanket `Bash` deny. Move that fix
  into F6, where it belongs.

### F12 — `reviewOnStatus` read-only review session

* **Purpose:** review the PR automatically when an issue enters a named state.
* **Commits:** `be869ab4`, `715bbdfc`, `61bfc2a1` (3)
* **Files:** `ReviewSessionTracker.ts` (new, 366), `GitService.ts`, `prompts/reviewOnStatusPrompt.ts` (new), `EdgeWorker.ts`, `core/config-schemas.ts`, 4 JSON schemas, `docs/REVIEW_ON_STATUS.md`
* **Tests:** `EdgeWorker.review-on-status.test.ts` (713 lines), `ReviewSessionTracker.test.ts`, `GitService.review-worktree.test.ts`, `RunnerConfigBuilder.review-stop-hook.test.ts`, `reviewOnStatusPrompt.test.ts`, `core/review-on-status-config.test.ts`, `core/review-tools.test.ts`
* **Recommendation: keep, but rebuild as one commit at the corrected design.**
* **`61bfc2a1` is a correction commit.** The PR #2 review found that three of
  the four isolation properties `be869ab4` claimed were not properties of the
  code: the sandbox blocked the reviewer from reading the diff; the Stop hook
  ordered a read-only reviewer to commit and push; a marker keyed by issue ID
  could be stolen by a concurrent human delegation, which ran the review as a
  full builder with write tools; and the design depended on an undocumented
  Linear webhook echo. **Rebuild at the corrected state.** The intermediate
  state is a security defect, not history worth keeping.

### F13 — Bundled Issue webhooks and visible declines (CYR-46)

* **Purpose:** make the `reviewOnStatus` trigger actually reachable.
* **Commits:** `00093f0b` (1)
* **Files:** `EdgeWorker.ts`, `docs/REVIEW_ON_STATUS.md`
* **Tests:** `EdgeWorker.review-trigger-reachability.test.ts` (+10)
* **Recommendation: keep, and split it. Two halves belong in different places.**
  1. **The dispatch fix belongs before F12.** The router tested the content
     predicate before the state predicate in an `else if` chain. Linear packs
     every field changed by one save into one `updatedFrom`, so renaming an
     issue as you move it to In Review is one webhook matching both — and the
     content handler won. This is a pre-existing upstream defect. Land it
     first, so `reviewOnStatus` is reachable on the commit that introduces it.
  2. **The observability half belongs with F14**, since it corrects F14.
* **See U2** — candidate to send upstream.

### F14 — Review-trigger reachability signal (CYR-33)

* **Purpose:** make an undeliverable trigger visible instead of silent.
* **Commits:** `254facc1` (1)
* **Files:** `EdgeWorker.ts`, `core/issue-tracker/types.ts`, `docs/REVIEW_ON_STATUS.md`
* **Tests:** `EdgeWorker.review-trigger-reachability.test.ts` (563 lines)
* **Recommendation: keep the tests and the corrected signal. Do not keep the
  original signal.**
* **The signal shipped over-claiming, and it cost real time.** It fired on
  **any** `Issue` webhook and announced that the trigger was reachable. It was
  observed doing that on a description edit, which can never reach the
  reviewer. That line was read as proof the trigger worked, ruled out the
  channel, and sent a live investigation to the wrong layer for hours
  (CYR-46). Rebuild with the narrowed signal from `00093f0b` only: fire on a
  webhook carrying a `stateId`, and say plainly when an `Issue` webhook cannot
  start a review.
* **`254facc1` also carries a wrong premise.** It concluded `reviewOnStatus`
  could not fire because the Linear app was not subscribed to the `Issue`
  resource. `00093f0b` later proved `Issue`/`update` webhooks were arriving all
  along. See decision Q1.

### F15 — Issue-webhook safety (CYR-35)

* **Purpose:** make the codebase safe once `Issue` webhooks are enabled.
* **Commits:** `736daec2`, `b2b41cdd` (2)
* **Files:** `EdgeWorker.ts`, `ReviewSessionTracker.ts`
* **Tests:** additions to `EdgeWorker.review-on-status.test.ts`, `ReviewSessionTracker.test.ts`
* **Recommendation: keep.** One commit. Two real guarantees: settle relevance
  from memory before `fetchIssue`, so Cyrus stops fetching every issue in the
  workspace on every state change; and make the two review triggers mutually
  exclusive, so a status change plus an @mention cannot start two concurrent
  reviews of one PR.
* **Depends on F16.** The second guarantee only means something while
  `reviewOnDelegateInStatus` exists. See Q1.

### F16 — `reviewOnDelegateInStatus` (CYR-33)

* **Purpose:** a second review trigger that does not need the `Issue` subscription.
* **Commits:** `e22c3190`, `571cfeea` (2)
* **Files:** `EdgeWorker.ts`, `ReviewSessionTracker.ts`, `core/config-schemas.ts`, 4 JSON schemas, `docs/CONFIG_FILE.md`, `docs/REVIEW_ON_STATUS.md`
* **Tests:** `EdgeWorker.review-on-delegate.test.ts` (334 lines)
* **Recommendation: DECISION REQUIRED — see Q1. Do not rebuild it by default.**
* **It was built on a diagnosis that later proved wrong.** F14 concluded the
  `Issue` subscription was missing, so F16 added a second route through
  `AgentSessionEvent`/`created`, which always arrives. `00093f0b` then found
  the subscription was never the problem — a routing defect was. With F13 in
  place, the original trigger should work, and the reason F16 exists is gone.
* **It also costs behaviour.** While enabled, delegating an issue in the review
  state always means "review this", never "build this". The two are
  indistinguishable at the webhook. `571cfeea` further found the documented
  route mostly does not work: for the common case — an issue Cyrus just built —
  Cyrus is already the delegate, and re-delegating starts nothing. Only an
  @mention reliably works.

### F17 — Persona sweep (CYR-37)

* **Purpose:** bring five inherited personas to one standard and add two.
* **Commits:** `2aeb99dc`, `0602fd7e` (2)
* **Files:** `prompts/builder.md`, `debugger.md`, `scoper.md`, `wayfinder.md` (new), `wayfinder-task.md` (new), `PromptBuilder.ts`, `ToolPermissionResolver.ts`, `core/allowed-tools-defaults.ts`, `core/config-schemas.ts`, 4 JSON schemas, `docs/PERSONAS.md`
* **Tests:** `PromptBuilder.persona-routing.test.ts` (201 lines)
* **Recommendation: keep.** One commit.
* **Carries a real fix worth its own visibility:** `allowedTools: "readOnly"`
  resolved to Slack's *chat* toolset, with no Grep, no Glob, and no git
  inspection. `scoper` runs read-only on all three production repos, so it
  could not search the code it was scoping. Consider splitting that fix out.

### F18 — `cyrus personas` command (CYR-43)

* **Purpose:** dry-run which persona and tools a label set would get.
* **Commits:** `1481cfce` (1)
* **Files:** `apps/cli/src/commands/PersonasCommand.ts` (302), `apps/cli/src/app.ts`, `edge-worker/src/index.ts`
* **Tests:** `PersonasCommand.test.ts` (18)
* **Recommendation: keep.** Depends on F17 and F9.

### F19 — Opus 5 by default (CYR-47)

* **Purpose:** let the `opus` alias reach the latest Opus.
* **Commits:** `c6cf445a`, `52297d6b` (2)
* **Files:** 4 `package.json`, `pnpm-lock.yaml`, `EdgeWorker.ts`
* **Tests:** none new.
* **Recommendation: keep, and land it last.** It touches the same files as the
  upstream release, so it should sit on top of the rebase where the conflict is
  easy to read. Replaces a stale hardcoded `claude-opus-4-6` fallback with the
  `opus` alias.

F4 folds into F3 in the commit plan, and F13 splits across two commits.

## 5. Cross-cutting defects to fix during the rebuild

**D1 — `CHANGELOG.md` has two `### Added` headings** under one `## [Unreleased]`
section. Merge them.

**D2 — Two changelog entries are concatenated into one bullet.** The CYR-33
reachability text runs straight into the CYR-25 deny-layer text inside a single
list item, with no line break. Split them.

**D3 — The CYR-15 changelog entry is false at the final state.** It says Slack
chat sessions lost shell access. F10's final design gives that command back and
enforces it. The fork left both entries in place and marked one
"*(superseded by CYR-20 above)*". The clean branch should carry one true entry.

**D4 — Several features have no changelog entry at all:** F1, F2, F3, F5, F6,
F7, F13, F17, F18. Write them.

**D5 — Test-count claims in commit messages will all be wrong** after squashing.
Either re-measure per commit or drop the counts.

## 6. Risks in the rebuild

**R1 — The security fixes are the easiest thing to get wrong.** F6, F10, F11 and
F12 each reached their final shape by finding that the previous shape did not
hold. Rebuilding "the feature" from the first commit of each chain reintroduces
a known hole. For each of these, build from the **last** commit's code, and read
the intermediate commit messages only to learn what must not regress.

**R2 — Ordering carries meaning.** F9 before F10, and F13 before F12. Both are
pre-existing upstream defects that our features made severe. Landing them first
means the clean branch never contains the broken combination.

**R3 — The live SDK tests do not run by default.** `live-sdk-precedence.test.ts`
needs `CYRUS_LIVE_SDK_TEST=1` and a real API key. Run them once against the
clean branch; they are the only thing that proves the deny layer beats
Claude Code's pre-approval.

**R4 — Nothing tests the Docker image.** CI runs Biome, build, and tests only.
The image is verified by deploying it. Build it once before merging.

**R5 — `reviewOnStatus` has never been confirmed firing in production.** Five
attempts over two weeks all failed. CYR-46 explains why and is marked Done, but
its fix has not yet been seen working live. Confirm on the clean branch before
treating F12 as delivered.

**R6 — A known limit of F12 is undocumented in the feature itself.** The
reviewer can only review Cyrus-built branches (the `branchName` constraint).
CYR-46 listed it as out of scope. Record it in `docs/REVIEW_ON_STATUS.md`.

## 7. Proposed commit plan

Nineteen commits on `clean-fork-rebuild`, branched from `upstream/main`
(`d1a98b80`, v0.2.67) rather than from the fork point — upstream has moved only
3 mechanical commits and rebasing now is cheaper than rebasing later.

| # | Commit | Depends on |
| -- | -- | -- |
| 1 | `docs: planning skills pack, tracker conventions, and the STE mandate` (F3 + F4) | — |
| 2 | `fix(tools): make the platform-default allowedTools fallback reachable` (F9) | — |
| 3 | `fix(edge-worker): run both handlers when one Issue webhook is content and state` (F13a) | — |
| 4 | `feat(core): engine-agnostic shell-command policy` (F8) | — |
| 5 | `feat(core): READONLY_CODE_TOOLS preset; repoint the readOnly preset` (part of F17) | 4 |
| 6 | `fix(claude): restrict built-in tools and enforce narrowed Bash grants` (F10) | 2, 4, 5 |
| 7 | `feat(tools): populate the disallowedTools deny layer` (F11) | 6 |
| 8 | `feat(grok): add Grok Build as a Cyrus agent runner over ACP` (F5) | — |
| 9 | `feat(grok): enforce the tool policy client-side` (F6 + the scoped-deny fix from F11) | 4, 8 |
| 10 | `feat(grok): continue after a policy denial, and audit denials` (F7) | 9 |
| 11 | `feat(edge-worker): reviewOnStatus read-only review session` (F12) | 3, 5, 6, 7 |
| 12 | `feat(edge-worker): review-trigger reachability signal and visible declines` (F14 corrected + F13b) | 11 |
| 13 | `fix(edge-worker): make the codebase safe for Issue webhooks` (F15) | 11 |
| 14 | *(optional)* `feat(edge-worker): reviewOnDelegateInStatus` (F16) — **only if Q1 says keep** | 11, 13 |
| 15 | `feat(prompts): sweep the personas and add the Wayfinder pair` (F17) | 5 |
| 16 | `feat(cli): add cyrus personas` (F18) | 2, 15 |
| 17 | `build(docker): self-host image and Dokploy runbook` (F1 + F2) | 8 |
| 18 | `chore(deps): claude-agent-sdk 0.3.220 and the opus alias` (F19) | — |
| 19 | `docs(changelog): one Unreleased section for the fork` (D1–D4) | all |

Commits 1–4 are independent and can be written in parallel. Commits 8–10 (Grok)
are independent of 11–14 (review) and can also run in parallel.

Verification gate after every commit: `pnpm build`, `pnpm typecheck`,
`pnpm test:packages:run`. Final gate: the section 2 baseline, plus the live SDK
suite (R3), plus a Docker build (R4).

## 8. Decisions needed before the rebuild starts

**Q1 — Keep `reviewOnDelegateInStatus` (F16)?**
It exists because F14 concluded the `Issue` subscription was missing. CYR-46
disproved that. With commit 3 in place, the original trigger should work, so
F16's reason to exist is gone. Keeping it costs a behaviour trade: while
enabled, delegating an issue in the review state always means "review this".
Three options:
1. **Drop it.** Smallest surface. Reverses if the status trigger fails again.
2. **Keep it, off by default** (today's state). Costs a config field, a code
   path, 334 lines of tests, and the mutual-exclusion logic in F15.
3. **Defer.** Land commits 1–13, confirm `reviewOnStatus` fires live (R5), then
   decide. **Recommended** — the evidence needed to decide does not exist yet.

**Q2 — Send the two upstream defects upstream?**
* **U1** — the unreachable `allowedTools` fallback (F9). Already written up in
  `docs/upstream/allowed-tools-fallback-unreachable.md`, marked "not filed
  upstream — William's call".
* **U2** — the `else if` chain that drops bundled Issue webhooks (F13a).
  Same class of defect, not yet written up.
* **U3** — `cyrus self-auth-linear` fails when `config.json` does not exist (F1).

**Q3 — One PR or several?**
Nineteen commits is large for one review. A natural split is four PRs:
tool permissions (1–7), Grok (8–10), review-on-status (11–14), and the rest
(15–19). Each is independently green.

**Q4 — Rebase onto `upstream/main` (v0.2.67), or stay on the fork point?**
This plan assumes the rebase. Confirm.
