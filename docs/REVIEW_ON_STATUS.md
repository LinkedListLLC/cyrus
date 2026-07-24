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
   three ways by `ReviewSessionTracker`:
   - a processed-webhook key (`createdAt:issueId`, mirroring `processedIssueUpdateKeys`),
   - an in-flight review guard per issue, so a second transition can't spawn a duplicate review,
   - a check against `AgentSessionManager.getSessionsByIssueId` for an already-running review.

3. **Fresh identity.** Cyrus mints a *new* Linear agent session on the issue via
   `createAgentSessionOnIssue`. This is what makes the review unbiased: it does not resume the
   builder's session, so it inherits none of the builder's context, tools, or self-justification.
   Multiple agent sessions per issue are supported — the session store keys on `agentSessionId`.

4. **Marker + routing.** Minting emits an `AgentSessionCreated` webhook that re-enters the normal
   `handleAgentSessionCreatedWebhook` → `initializeAgentRunner` path. To keep that path from
   starting a *builder*, the minted session id is registered in `ReviewSessionTracker`, and both
   `handleAgentSessionCreatedWebhook` and `initializeAgentRunner` check the marker first and
   divert to `initializeReviewRunner`. Because the webhook can in principle arrive before the
   mint call resolves, the marker is also registered by `issueId` *before* minting and reconciled
   to the session id afterwards; the pending-by-issue marker expires after 5 minutes so it can
   never hijack an unrelated human-started session.

   The review runner never enters `assemblePrompt`, so label-derived system prompts, the
   `AGENT_SESSION_MARKER` mention heuristic, and label-driven runner/model selection are all
   bypassed — a shallow persona override would not have been enough.

5. **Clean checkout.** The review does **not** reuse the issue-keyed worktree: that is the
   builder's tree and may be dirty or mid-edit. `GitService.createReviewWorktree` adds a
   **session-scoped, detached-HEAD** worktree at the PR head (`origin/<branch>` when the branch
   exists on the remote, else the local branch, else the base branch). Detached HEAD also side-steps
   git's "branch is already checked out in another worktree" guard. The worktree lives until the
   issue reaches a terminal state, so a follow-up question resumes in the same clean checkout.

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
  pruning, in-flight guard, marker consumption including the mint/webhook race and expiry.
- `reviewOnStatusPrompt.test.ts` — prompt contains the read-only mandate and the structured
  output contract.
- `review-tools.test.ts` (core) — the review tool set is read-only, includes `mcp__linear`, and
  denies every write tool.
- `config-schemas` — `reviewOnStatus` parses and is optional.
- `EdgeWorker.review-on-status.test.ts` — the webhook gate: mints exactly one session for a
  matching transition, no session for a non-matching state, unset config, or a duplicate webhook;
  the minted session routes to the review runner while a human session on the same issue does not;
  a resumed review keeps the read-only toolset; terminal-state handling is unchanged.
- `GitService.review-worktree.test.ts` — real git repositories, not mocks: the review checkout is
  detached at the PR head, is not the builder's dirty worktree, is unique per review, falls back to
  the base branch when the branch is missing, and cleans up without leaving stale worktree entries.

## Known limitations

- **Not verified end-to-end against a live Linear workspace.** The trigger, de-dup, tool set and
  worktree logic are unit-tested; a real "In Review" transition needs the deployed instance.
- The review posts to **Linear only**. Posting a GitHub PR review is out of scope for v1.
- The PR head is resolved from the issue's branch name, not from the GitHub PR API. For issues
  whose PR branch differs from the Linear branch name, the review falls back to the base branch
  and says so.
