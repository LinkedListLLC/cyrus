# Cloud smoke brief

Run this in a Claude Code cloud session. Setup and dispatch: the `Cloud sessions` section of `CLAUDE.md`.

```
GOAL         Prove what this repo can do in a cloud session: run the smoke check, record
             the table on this session's branch, and report skill visibility.

SCOPE        May write: docs/cloud-smoke/<UTC date>.md (new file, or append).
             May push: only the branch this session works on (SalonPrive's cloud runs on
             2026-09-28 saw the session make its own claude/... branch).
             May not write: anything else.

CONTEXT      scripts/cloud/session-start.sh  SessionStart hook; its summary is at the top of
                                             your context, full log /tmp/cloud-session-start.log
             scripts/cloud/smoke.sh          the smoke registry and runner
             scripts/cloud/setup.sh          the environment setup script (pnpm, jq, gh,
                                             pstack plugin, first pnpm install)
             CLAUDE.md, Cloud sessions       environment settings and what runs where
             setup.sh installs pstack, so pstack:poteto-mode should be visible. GitHub
             GraphQL is blocked here, so use `gh api` (REST) for any GitHub read.

ACCEPTANCE   1. You quote the SessionStart hook summary. If it is absent, say so and
                run `CLAUDE_CODE_REMOTE=true bash scripts/cloud/session-start.sh` once.
             2. `bash scripts/cloud/smoke.sh` ran to the end; you have its full stdout.
             3. You list the skills you can see and say yes or no: is
                `pstack:poteto-mode` available?
             4. You record the output of `echo $CLAUDE_CODE_REMOTE_SESSION_ID`.
             5. docs/cloud-smoke/<UTC date>.md holds the session id, the hook summary,
                the smoke table, and the not-runnable list; it is committed and
                `git push origin HEAD` succeeded.

VERIFY       date -u +%F                                  # file name
             bash scripts/cloud/smoke.sh                  # exit 1 means a surface FAILed; still record it
             git log -1 --stat                            # only the smoke file changed
             git push origin HEAD
             Gotchas: a SKIP(<need>) row names the unmet precondition, not a bug.
             SKIP(jq) or SKIP(gh) means setup.sh did not install that tool; the hook
             summary has a WARN line for it. SKIP(deps) or SKIP(build) follows from an
             earlier FAIL. F1 test drives are not runnable here: they need an Anthropic
             credential, which this environment does not have.

TIMEBOX      30 minutes. The smoke check alone takes about 5. On expiry, commit and push
             what you have, then report.

FORBIDDEN    Editing product code or scripts (report a bug; do not fix it). Force-push.
             Merging. Touching main. Pushing to any branch other than your own.
             Deleting any branch (the proxy refuses it, so a pushed branch stays behind
             as junk). Printing secret values.

REPORT       Final message, in this order:
             - the smoke table and not-runnable list, verbatim
             - push result: `git push origin HEAD` (commit SHA, branch)
             - skill visibility: the skill list, and yes/no for pstack:poteto-mode
             - CLAUDE_CODE_REMOTE_SESSION_ID
             - each FAIL with a one-line suspected cause
```
