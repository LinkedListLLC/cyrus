# Fork inventory and clean-branch plan

**Issue:** [CYR-48](https://linear.app/linkedlist/issue/CYR-48)
**Written:** 2026-07-28
**Status:** approved. William answered all four questions on 2026-07-28 — see
section 8. The rebuild follows the commit plan in section 7.

## 1. The fork point

| Item | Value |
| -- | -- |
| Upstream | `ceedaragents/cyrus` (`upstream/main`) |
| Fork | `LinkedListLLC/cyrus` (`origin/main`) |
| Fork point (merge base) | `516d8a03` — "Patch Cyrus CLI security advisories (#1383)", 2026-07-23 |
| Our commits after it | 50, all linear. No merge commits. |
| Upstream commits after it | 3 |
| Net change | 134 files, +17283 / −584 |

The count was 45 when this document was first written. PRs #22 and #23 added
five more — see F20 and the notes on F1 and F3.

Command that finds it again:

```bash
git merge-base origin/main upstream/main    # 516d8a033647612d5e7dd2ff88cc7f1951d7eac2
```

## 2. Baseline of the current fork tip

Measured twice. The first column is the fork tip as this document was first
written. The second is the same 50 commits replayed onto upstream v0.2.67 — the
rebase audit of section 3.1, and the real acceptance gate.

| Check | `166368dc` | rebased onto `d1a98b80` |
| -- | -- | -- |
| `pnpm install` | pass | pass, lockfile unchanged |
| `pnpm build` | pass | pass |
| `pnpm typecheck` | pass | pass |
| `pnpm test:packages:run` | pass | pass |
| edge-worker | 898 tests, 76 files | 909 tests, 77 files |
| core | 150 | 150 |
| claude-runner | 166, 5 skipped (live SDK, opt-in) | 166, 5 skipped |
| grok-runner | 103 | 103 |
| gemini-runner | — | 198, 1 skipped |
| github-event-transport | — | 117 |
| codex-runner | — | 69 |

The clean branch must hold the second column. Use it as the acceptance gate.
The 11 extra edge-worker tests are F20 (CYR-53), which landed after the first
measurement.

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

### 3.1 Rebase audit (Q4)

Run on 2026-07-28, on a scratch worktree, to measure the real cost of the rebase
before committing to it:

```bash
git worktree add /tmp/rebase-probe -b probe/rebase-audit origin/main
cd /tmp/rebase-probe
git rebase --onto upstream/main 516d8a03 probe/rebase-audit
```

Result:

| Measure | Value |
| -- | -- |
| Commits replayed | 50 of 50 |
| Files with a code conflict | **0** |
| Files with any conflict | 1 — `CHANGELOG.md`, on 3 commits |
| `pnpm install` | lockfile unchanged, so the auto-merge is coherent |
| `pnpm build` / `typecheck` / `test:packages:run` | all pass |
| Tree difference from `origin/main` | the upstream delta only, nothing else |

The three `CHANGELOG.md` conflicts are structural, not semantic: upstream moved
its `[Unreleased]` block into a `[0.2.67]` section, and our entries want a fresh
`[Unreleased]` above it. The clean branch rewrites that file anyway (D1–D4), so
the conflicts are throwaway.

The hand checks in section 3 hold on the rebased tree: package version `0.2.67`,
our SDK `0.3.220`, and upstream's Codex runtime `0.144.4`, all at once.

**The rebase costs nothing. No path decision is needed.**

## 4. Feature inventory

Twenty features. The 50 commits map onto them with no remainder.

### F1 — Self-host Docker image and Dokploy runbook

* **Purpose:** build and run this fork as a headless container on Dokploy.
* **Commits:** `1f919524`, `4bfb26f1`, `4b848f68`, `a6223e48`, `e8dc8cc4`, `af55a26c`, `3c7e9ea4` (7)
* **Files:** `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore`, `.gitignore`, `docs/DOKPLOY.md`
* **Tests:** none. CI never builds the image. See risk R4.
* **Recommendation: keep.** Squash the eight commits into one. Six of them are
  doc additions to the same file, written as the deploy was debugged.
* **Notes:** `4b848f68` seeds `config.json` because `cyrus self-auth-linear`
  fails without it. That is an upstream usability defect — see U3.
* **Added after this document was first written:** `e8e7f462` sets
  `CLAUDE_CONFIG_DIR` into the Dokploy volume, so a redeploy no longer deletes
  every Claude transcript and dead-ends the open sessions that resume them.
  Fold it into the same commit.

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
* **Commits:** `a28d659b`, `d06ba5f4`, `166368dc`, `f96b01ca`, `20587949` (5)
* **Files:** `.agents/skills/**` (wayfinder, research, grilling, prototype, domain-modeling, handoff, adhd), `.claude/skills/*` symlinks, `skills-lock.json`, `docs/agents/issue-tracker.md`, `CLAUDE.md`
* **Tests:** not applicable.
* **Recommendation: keep.** Squash into one commit.
* **Added after this document was first written:** `f96b01ca` and `20587949`
  make every PR target our fork instead of upstream. Both are `CLAUDE.md` house
  rules — fold them in.

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
* **Recommendation: keep the first guarantee, drop the second.** Settle
  relevance from memory before `fetchIssue`, so Cyrus stops fetching every issue
  in the workspace on every state change. That guarantee stands on its own.
* **The second guarantee goes with F16.** Making the two review triggers
  mutually exclusive only means something while `reviewOnDelegateInStatus`
  exists, and Q1 drops it. What stays is the status trigger's own re-entrancy
  guard (`hasReviewInFlight` in `maybeStartStatusReview`), which stops two
  Issue webhooks in quick succession from starting two reviews of one PR.

### F16 — `reviewOnDelegateInStatus` (CYR-33)

* **Purpose:** a second review trigger that does not need the `Issue` subscription.
* **Commits:** `e22c3190`, `571cfeea` (2)
* **Files:** `EdgeWorker.ts`, `ReviewSessionTracker.ts`, `core/config-schemas.ts`, 4 JSON schemas, `docs/CONFIG_FILE.md`, `docs/REVIEW_ON_STATUS.md`
* **Tests:** `EdgeWorker.review-on-delegate.test.ts` (334 lines)
* **Recommendation: DROP. Decided by William on 2026-07-28 — see Q1.** It is
  the same feature as F12 behind a second trigger, and F12 is now confirmed
  firing live. Do not rebuild it.
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
* **What the drop removes.** Audited on the fork tip. The excision is clean —
  nothing outside this list refers to it:

  | Item | Where |
  | -- | -- |
  | `maybeStartDelegatedReview()` and its one call site | `EdgeWorker.ts` |
  | `adoptReviewSession()` | `ReviewSessionTracker.ts` |
  | `reviewOnDelegateInStatus` field | `core/src/config-schemas.ts` + 4 JSON schemas |
  | `EdgeWorker.review-on-delegate.test.ts` | 334 lines |
  | `adoptReviewSession` describe block | `ReviewSessionTracker.test.ts` |
  | 2 references | `EdgeWorker.review-on-status.test.ts` |
  | Trigger documentation | `docs/REVIEW_ON_STATUS.md`, `docs/CONFIG_FILE.md` |

  `hasReviewInFlight()` stays: `maybeStartStatusReview` calls it independently.
* **How to reverse it if the status trigger fails again:** the code is on
  `origin/main` at `e22c3190` and `571cfeea`. Cherry-pick, do not rewrite.

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

### F20 — Unstick a session after a stop (CYR-53)

* **Purpose:** stop a Linear agent session hanging on "starting task" forever.
* **Commits:** `365a498f`, `fa714629` (2)
* **Files:** `AgentSessionManager.ts`, `EdgeWorker.ts`
* **Tests:** `AgentSessionManager.stop-session.test.ts` (+), `EdgeWorker.stale-resume-recovery.test.ts` (396 lines)
* **Recommendation: keep.** One commit. Landed after this document was first
  written (PR #23). Two defects: a stop flag that no later turn consumed, and a
  resume ID the Claude CLI could no longer find. The container half of the same
  investigation is in F1 (`e8e7f462`).

F4 folds into F3 in the commit plan, F13 splits across two commits, and F16 is
dropped.

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

**R5 — CLOSED. `reviewOnStatus` is confirmed firing in production.** Five
attempts over two weeks failed before CYR-46 found the routing defect. William
confirmed the trigger live on 2026-07-28. This is what lets Q1 drop F16 instead
of deferring the decision.

**R6 — A known limit of F12 is undocumented in the feature itself.** The
reviewer can only review Cyrus-built branches (the `branchName` constraint).
CYR-46 listed it as out of scope. Record it in `docs/REVIEW_ON_STATUS.md`.

## 7. Commit plan

Nineteen commits, branched from `upstream/main` (`d1a98b80`, v0.2.67) — the
rebase of section 3.1. They go on four stacked branches, one per PR (Q3). Each
PR targets the branch below it, so each review shows only its own commits.

### PR 1 — Tool permissions and enforcement

| # | Commit | Depends on |
| -- | -- | -- |
| 1 | `fix(tools): make the platform-default allowedTools fallback reachable` (F9) | — |
| 2 | `feat(core): engine-agnostic shell-command policy` (F8) | — |
| 3 | `feat(core): READONLY_CODE_TOOLS preset; repoint the readOnly preset` (part of F17) | 2 |
| 4 | `fix(claude): restrict built-in tools and enforce narrowed Bash grants` (F10) | 1, 2, 3 |
| 5 | `feat(tools): populate the disallowedTools deny layer` (F11) | 4 |

### PR 2 — Grok Build runner (on PR 1)

| # | Commit | Depends on |
| -- | -- | -- |
| 6 | `feat(grok): add Grok Build as a Cyrus agent runner over ACP` (F5) | — |
| 7 | `feat(grok): enforce the tool policy client-side` (F6 + the scoped-deny fix from F11) | 2, 6 |
| 8 | `feat(grok): continue after a policy denial, and audit denials` (F7) | 7 |

Commit 6 keeps Gautam Jain as author.

### PR 3 — `reviewOnStatus` (on PR 2)

| # | Commit | Depends on |
| -- | -- | -- |
| 9 | `fix(edge-worker): run both handlers when one Issue webhook is content and state` (F13a) | — |
| 10 | `feat(edge-worker): reviewOnStatus read-only review session` (F12) | 3, 4, 5, 9 |
| 11 | `feat(edge-worker): review-trigger reachability signal and visible declines` (F14 corrected + F13b) | 10 |
| 12 | `fix(edge-worker): settle review relevance before fetching the issue` (F15, first guarantee only) | 10 |

F16 is dropped (Q1), so there is no delegation trigger and no mutual-exclusion
commit. Commit 12 keeps the `hasReviewInFlight` guard inside the status trigger.

### PR 4 — Personas, CLI, deploy, deps, docs (on PR 3)

| # | Commit | Depends on |
| -- | -- | -- |
| 13 | `docs: planning skills pack, tracker conventions, and the house rules` (F3 + F4) | — |
| 14 | `feat(prompts): sweep the personas and add the Wayfinder pair` (F17) | 3 |
| 15 | `feat(cli): add cyrus personas` (F18) | 1, 14 |
| 16 | `fix(edge-worker): unstick a session after a stop and a dead resume ID` (F20) | — |
| 17 | `build(docker): self-host image and Dokploy runbook` (F1 + F2) | 6, 16 |
| 18 | `chore(deps): claude-agent-sdk 0.3.220 and the opus alias` (F19) | — |
| 19 | `docs(changelog): one Unreleased section for the fork` (D1–D4) | all |

### Gates

Per commit: `pnpm build` and `pnpm typecheck`. Per PR tip: add
`pnpm test:packages:run`. Final gate: the section 2 baseline (second column),
plus the live SDK suite (R3), plus a Docker build (R4).

### Construction method

Section 3.1 proved the 50 commits replay onto v0.2.67 with no code conflict, so
**reuse the code, never retype it.** Build each clean commit from the rebased
tree, not from the original commit of a chain — R1. Where a feature reversed
itself, the rebased tip already holds the final design.

## 8. Decisions taken

William answered on 2026-07-28. Recorded here so the rebuild does not reopen them.

**Q1 — `reviewOnDelegateInStatus` (F16): DROP.**
It is the same feature as `reviewOnStatus` behind a second trigger, and
`reviewOnStatus` is now confirmed firing live (R5 is closed). The reason F16
existed is gone, so it goes. The excision list is in F16; the code stays
reachable on `origin/main` at `e22c3190` if the status trigger ever fails again.

**Q2 — Upstream reports (U1, U2, U3): HOLD.**
Do not send anything upstream until our own fixes are tight. Keep
`docs/upstream/allowed-tools-fallback-unreachable.md`, and write U2 up in the
same place, but file neither. Revisit after the four PRs merge.

**Q3 — Four PRs.** Split as in section 7. Stacked, each on the one below.

**Q4 — Rebase onto `upstream/main` (v0.2.67): YES.**
Section 3.1 measured it: 50 of 50 commits replay, zero code conflicts, one
throwaway `CHANGELOG.md` conflict, and the result builds, typechecks and passes
every package suite. No fallback path is needed.

## 9. Still open

**M1 — How `main` takes the clean history.** The four PRs rebuild content that
`origin/main` already carries, so they cannot target `main` — the diff would be
empty. They stack on a snapshot of `upstream/main` instead. Once all four merge,
`main` has to be moved to the stack tip, which rewrites 50 commits of published
history and needs William's explicit go-ahead. Alternatives: keep the old history
on an archive branch (`main-pre-rebuild`) before moving, or merge the stack into
`main` as one merge commit and accept the duplicate history.
