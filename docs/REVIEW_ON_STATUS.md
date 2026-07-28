# Review on Status (`reviewOnStatus`)

When a Linear issue moves into a configured workflow state (typically **"In Review"**), Cyrus
starts a **fresh, isolated, read-only review session** that reads the PR diff and posts a
structured review back to the Linear issue.

The review runs on the same Cyrus instance as the builder session — no second OAuth app, no
relay — but it is deliberately **not** a continuation of the builder's session. It gets its own
Linear agent session, its own git worktree, and a tool set that cannot write code.

---

## Configuration

Per repository, in `~/.cyrus/config.json`:

```json
{
  "repositories": [
    {
      "id": "my-repo",
      "name": "My Repo",
      "repositoryPath": "/home/user/my-repo",
      "baseBranch": "main",
      "workspaceBaseDir": "/home/user/.cyrus/worktrees",
      "reviewOnStatus": "In Review"
    }
  ]
}
```

### `reviewOnStatus` (string, optional)

The **name** of the Linear workflow state that triggers a review (matched case-insensitively,
whitespace-trimmed). Unset or empty disables the feature for that repository — this is the
default, so existing configs are unaffected.

`reviewOnStatus` is a per-repository field, so it hot-reloads with the rest of the repository
entry: `ConfigManager` diffs repository objects wholesale and `EdgeWorker.updateModifiedRepositories`
spreads the new object into the live map. No `ConfigManager` change is needed (unlike the global
`prReviewTrigger` flag, which is threaded through a hardcoded whitelist).

---

## How it works

1. **Trigger.** Linear sends an `Issue` / `update` webhook whose `updatedFrom` contains `stateId`.
   `EdgeWorker.handleIssueStateChange` resolves the new state. Terminal states (`completed`,
   `canceled`) keep their existing wind-down behavior. Otherwise, if the routed repository has
   `reviewOnStatus` matching the new **state name**, the review flow starts.

2. **De-duplication.** Linear re-sends webhooks and users re-save issues, so the trigger is guarded
   two ways by `ReviewSessionTracker`:
   - a processed-webhook key (`createdAt:issueId`, mirroring `processedIssueUpdateKeys`) — catches
     a redelivery of the *same* transition,
   - an in-flight review guard per issue — catches a genuinely new transition arriving while a
     review is still running.

3. **Fresh identity.** Cyrus mints a *new* Linear agent session on the issue via
   `createAgentSessionOnIssue`. This is what makes the review unbiased: it does not resume the
   builder's session, so it inherits none of the builder's context, tools, or self-justification.
   Multiple agent sessions per issue are supported — the session store keys on `agentSessionId`.

4. **Marker + routing.** The review is started **directly from the mint result**, not from a
   webhook. Linear documents `AgentSessionEvent`/`created` only for human delegation and @mention
   and says nothing about echoing back a session an app creates for itself, so treating that echo
   as the trigger would make the feature depend on undocumented behavior and fail *silently* if it
   never arrived. See "Verified vs assumed" below.

   The marker in `ReviewSessionTracker` is bound to **the minted session id and nothing else**, and
   claiming it is one-shot. That gives two properties:
   - A concurrent human delegation on the same issue can never be handed the review marker — it
     stays a normal builder session, and the minted session stays the review.
   - If Linear *does* echo the creation, `handleAgentSessionCreatedWebhook` finds the marker already
     claimed, recognizes the session via `isReviewSession`, and drops the event rather than starting
     a second runner or a builder on the review's own session id.

   The one genuine race — an echo arriving before the mint call has returned an id — is resolved by
   *waiting* for the mint to settle (`awaitPendingMint`, bounded at 10s), never by guessing.

   The review runner never enters `assemblePrompt`, so label-derived system prompts, the
   `AGENT_SESSION_MARKER` mention heuristic, and label-driven runner/model selection are all
   bypassed — a shallow persona override would not have been enough. On resume, labels and the
   issue description are withheld for the same reason: both are issue-controlled text, and an
   `[agent=...]` tag must not be able to reshape a session whose contract is that it cannot be
   reshaped.

5. **Clean checkout.** The review does **not** reuse the issue-keyed worktree: that is the
   builder's tree and may be dirty or mid-edit. `GitService.createReviewWorktree` adds a
   **session-scoped, detached-HEAD** worktree at the PR head (`origin/<branch>` when the branch
   exists on the remote, else the local branch, else the base branch). Detached HEAD also side-steps
   git's "branch is already checked out in another worktree" guard. The worktree lives until the
   issue reaches a terminal state, so a follow-up question resumes in the same clean checkout.

   Anything other than `origin/<branch>` sets `usedFallbackRef` and is announced in the thread —
   including the local branch. A merged or deleted remote branch leaves a stale local copy that is
   *not* the pull request, and reviewing it silently would misrepresent what was read.

   Two consequences of the detached worktree drive the session config:
   - Its refs and object store live in the **main repository**
     (`<repo>/.git/worktrees/<name>` and `<repo>/.git`), so `allowedDirectories` must include the
     repository path and those metadata directories. Sandboxing the reviewer to the worktree alone
     breaks every `git diff`/`git log` the review is built on.
   - The "you have unshipped work" **Stop hook is not installed** for a review
     (`readOnlySession` on the runner config). On a detached HEAD `@{u}` does not resolve, so the
     guardrail falls back to `origin/HEAD` and counts the pull request's *own* commits as unpushed
     — blocking the stop and ordering a read-only reviewer to commit, push, and open a PR.

6. **Read-only by construction.** The review session is granted `REVIEW_ALLOWED_TOOLS`
   (`packages/core/src/allowed-tools-defaults.ts`): read-only code tools + `mcp__linear` (so it can
   read the issue and post) + a narrow set of read-only git/gh commands so it can actually see the
   diff. `Edit`, `Write`, `NotebookEdit` and general `Bash` are additionally listed in
   `REVIEW_DISALLOWED_TOOLS`, which is an instant deny that takes precedence over any allow rule.
   The reviewer cannot edit, commit, push, or "just fix it".

   The posture is **sticky**. A follow-up comment in the review thread resumes the session through
   `resumeAgentSession`, which normally rebuilds the config with the full builder toolset and a
   label-derived persona. The session is marked `metadata.readOnlyReview`, and that branch restores
   the review toolset and review system prompt — so "can you just fix it?" gets an answer, not a
   commit.

7. **Output.** The reviewer's activities stream to the Linear agent session (source `"linear"`),
   and its final response is a structured review: **Blocking / Non-blocking / Nits** plus a
   one-line verdict, with `file:line` citations.

---

## Modules touched

| File | Change |
| --- | --- |
| `packages/core/src/config-schemas.ts` | `reviewOnStatus` on `RepositoryConfigSchema` |
| `packages/core/src/allowed-tools-defaults.ts` | `REVIEW_ALLOWED_TOOLS`, `REVIEW_DISALLOWED_TOOLS` |
| `packages/core/src/CyrusAgentSession.ts` | `metadata.readOnlyReview`, `metadata.reviewSystemPrompt` |
| `packages/edge-worker/src/ReviewSessionTracker.ts` | new — trigger matching, de-dup, session markers |
| `packages/edge-worker/src/prompts/reviewOnStatusPrompt.ts` | new — review system + user prompt |
| `packages/edge-worker/src/GitService.ts` | `createReviewWorktree`, `removeReviewWorktree` |
| `packages/edge-worker/src/EdgeWorker.ts` | trigger branch, session minting, `initializeReviewRunner` |

## Tests

- `ReviewSessionTracker.test.ts` — state-name matching (case/whitespace), webhook de-dup and
  pruning, in-flight guard, and marker ownership: a marker is claimable only by the session id it
  was minted for, a mid-mint human session gets nothing, a claimed session stays recognizable so a
  late echo is not restarted as a builder, and `awaitPendingMint` resolves on bind, on abandon, and
  on timeout.
- `reviewOnStatusPrompt.test.ts` — prompt contains the read-only mandate and the structured
  output contract.
- `review-tools.test.ts` (core) — the review tool set is read-only, includes `mcp__linear`, and
  denies every write tool.
- `config-schemas` — `reviewOnStatus` parses and is optional.
- `EdgeWorker.review-on-status.test.ts` — the webhook gate: mints exactly one session for a
  matching transition, no session for a non-matching state, unset config, or a duplicate webhook;
  the review starts from the mint result with no echo, and a subsequent echo is swallowed;
  **a human delegation racing an in-flight mint does not steal the review marker** (the mint is
  held open so the two genuinely overlap); the review's `allowedDirectories` include the repo and
  its git metadata; a resumed review keeps the read-only toolset and is not exposed to
  label/description runner selectors; terminal-state handling is unchanged.
- `GitService.review-worktree.test.ts` — real git repositories, not mocks: the review checkout is
  detached at the PR head, is not the builder's dirty worktree, is unique per review, falls back to
  the base branch when the branch is missing, flags the local branch as a fallback when the remote
  head is gone, keeps its git metadata outside the worktree, and cleans up without leaving stale
  worktree entries.
- `RunnerConfigBuilder.review-stop-hook.test.ts` — against a real detached worktree at a PR head,
  the ship guardrail *would* block the review and order it to commit and push; a read-only session
  gets no Stop hook, while builder sessions still do.

## Verified vs assumed

Stated explicitly because the design has one load-bearing external behavior.

- **Assumed, and deliberately not depended on:** that Linear delivers an `AgentSessionEvent` /
  `created` webhook for an agent session the app creates for itself via `agentSessionCreateOnIssue`.
  Linear's agent docs describe that webhook only for human delegation and @mention; the webhooks
  docs say nothing about self-echo suppression either way. The SDK's `AgentSessionWebhookPayload`
  does document `creator` as *"unset if the session was initiated via automation or by an agent
  user"*, which implies such payloads exist — but that is an inference, not a guarantee. The code
  therefore starts the review from the mint result and treats any echo as an optional duplicate.
- **Verified in this repo (real git, not mocks):** the detached-worktree facts that drive the
  sandbox and Stop-hook configuration — where a linked worktree's metadata lives, and that the
  ship guardrail counts a PR's own commits as unpushed on a detached HEAD.
- **Not verified:** any behavior of a live Linear workspace. No end-to-end run was performed.

## Known limitations

- The review posts to **Linear only**. Posting a GitHub PR review is out of scope for v1.
- **It can only review branches Cyrus itself built.** The PR head is resolved from the issue's
  branch name, not from the GitHub PR API, so a pull request opened by a human on a differently
  named branch is invisible to the reviewer. In that case the review falls back to the base branch
  and says so — it does not stay silent, but it also does not review the PR you meant.
- `ReviewSessionTracker` state is in-memory. If the process restarts between minting a session and
  starting its runner, that session is left unclaimed — a later echo for it would be treated as a
  normal delegation. The window is the few milliseconds between the mint returning and the runner
  starting, and the per-issue guard is dropped with the rest of the state, so a subsequent
  transition can always start a fresh review.
- Review worktrees are removed when the review completes or the issue reaches a terminal state, but
  a process restart in between leaves them on disk until the next terminal transition for that
  issue.
