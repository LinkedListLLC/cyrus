/**
 * Per-platform default allowed-tool lists.
 *
 * These are the single source of truth for "what tools does Cyrus have access
 * to when a session is triggered by platform X". cyrus-hosted and any
 * self-host configuration imports these constants verbatim; the database
 * stores per-team overrides only, and falls back to these lists when a team
 * has not customized its allowed-tool set.
 *
 * Resolution is **additive only** — there is no implicit appending of
 * workspace MCP tools at runtime. Anything Cyrus needs (including
 * `mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`, `mcp__slack`, and
 * read access to repository paths) is listed here explicitly. If you remove
 * a tool from this list, Cyrus loses access to it. If you add a tool here,
 * existing teams whose column equals the previous verbatim default will be
 * migrated forward; teams who have customized their list are left alone.
 *
 * The three lists are intentionally maintained independently — sharing tools
 * between platforms is fine and expected, but the lists do not derive from
 * each other.
 */

/**
 * Default allowed tools for Linear-triggered agent sessions.
 *
 * Linear sessions are full engineering sessions — Cyrus opens worktrees,
 * runs builds, edits files, and opens PRs. This list mirrors the full
 * Claude Agent SDK toolset plus the workspace MCP prefixes Cyrus needs
 * to read and write Linear state.
 */
export const LINEAR_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Worktree management
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",

	// Workspace MCP servers — explicit, no implicit appending. Linear
	// sessions include `mcp__slack` so Cyrus can post status updates and
	// follow-up messages to Slack while working on an issue.
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	"mcp__slack",
] as const;

/**
 * Default allowed tools for Slack `@mention` chat sessions.
 *
 * Slack sessions are transient — no PRs opened, no worktree checkouts.
 * The default list grants read-only access to repository sources (so Cyrus
 * can answer "look at the code in repo X" questions) plus the standard
 * planning/task tools, but no Edit/Write and no general Bash.
 *
 * Note on `Bash(git -C * pull)`: an argument-narrowed entry like this means
 * exactly what it says — the session may run `git -C <dir> pull`, and no other
 * shell command. `allowedTools` alone cannot deliver that, because its patterns
 * only *auto-approve* and never deny; each runner therefore enforces the
 * narrowing itself. Grok and Cursor translate the entry into their own
 * natively-enforced permission rules; the Claude runner checks every command in
 * `canUseTool` against `commandMatchesAllowedBash` (see
 * `packages/core/src/shell-command-policy.ts`), so a chain like
 * `git -C x pull && rm -rf /` is refused rather than approved on its first word.
 *
 * Until CYR-20 the Claude runner instead failed closed and withheld Bash
 * altogether, so this entry silently granted nothing there — which is how a
 * review persona ended up unable to run `git diff`.
 */
export const SLACK_DEFAULT_ALLOWED_TOOLS = [
	// Read access to configured repository paths
	"Read",
	"Bash(git -C * pull)",

	// Web
	"WebFetch",
	"WebSearch",

	// User interaction — Slack chat sessions need to send replies back
	// to the channel and schedule follow-ups.
	"SendMessage",
	"ScheduleWakeup",

	// Planning + task lifecycle
	"Task",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Discovery
	"Monitor",
	"Skill",
	"ToolSearch",

	// Workspace MCP servers Slack chat sessions need
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	"mcp__slack",
] as const;

/**
 * Default allowed tools for GitHub-triggered agent sessions.
 *
 * GitHub sessions are full engineering sessions like Linear (Cyrus opens
 * PRs, edits files, runs builds), so the toolset mirrors the Linear
 * default — except `mcp__slack` is excluded since Slack is its own
 * platform with its own allowed-tool list.
 *
 * Maintained as an independent list (NOT derived from
 * `LINEAR_DEFAULT_ALLOWED_TOOLS`) so the two can diverge without one of
 * them silently inheriting the other's changes.
 */
export const GITHUB_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Worktree management
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",

	// Workspace MCP servers GitHub sessions need
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
] as const;

/**
 * Allowed tools for `reviewOnStatus` review sessions.
 *
 * A review session exists to *read* a diff and *say* what it thinks. It is
 * read-only by construction: no `Edit`, no `Write`, no `NotebookEdit`, and no
 * general `Bash`. The only shell commands granted are read-only git/gh
 * inspection commands, because the bare read-only toolset has no `Bash` at all
 * and a reviewer that cannot run `git diff` cannot review anything.
 *
 * `mcp__linear` is included deliberately — the review needs to read the issue
 * and post its verdict back to Linear. That is the one write this session is
 * allowed to make, and it writes to the issue tracker, never to code.
 *
 * Pair this with {@link REVIEW_DISALLOWED_TOOLS}: `disallowedTools` is an
 * instant deny that takes precedence over any allow rule, so the write tools
 * stay blocked even if a repository's own `allowedTools` is merged in.
 */
export const REVIEW_ALLOWED_TOOLS = [
	// Read-only code access
	"Read",
	"Glob",
	"Grep",

	// Read-only diff inspection. `git`/`gh` subcommands are enumerated
	// individually — `Bash(git:*)` would also permit `git push`/`git commit`.
	"Bash(git diff:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
	"Bash(git status:*)",
	"Bash(git blame:*)",
	"Bash(gh pr view:*)",
	"Bash(gh pr diff:*)",

	// Web
	"WebFetch",
	"WebSearch",

	// Planning + discovery (task tools only mutate task tracking, not code)
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"ToolSearch",

	// Issue tracker — read the issue, post the review
	"mcp__linear",
] as const;

/**
 * Allowed tools for the `readOnly` preset — any persona that investigates a
 * codebase and reports back without changing it (`scoper`, the read-only
 * Wayfinder persona, and any future analyst).
 *
 * Until CYR-37 the `readOnly` preset resolved to
 * {@link SLACK_DEFAULT_ALLOWED_TOOLS}, which is a *chat* toolset: it has no
 * `Grep`, no `Glob`, and no git inspection commands. A `scoper` configured
 * `readOnly` therefore could not search the codebase it was scoping — it could
 * only `Read` paths it already knew. That is the same gap that forced
 * {@link REVIEW_ALLOWED_TOOLS} to hand-roll its own list, so this constant
 * generalises that list for label-based personas.
 *
 * Differences from {@link REVIEW_ALLOWED_TOOLS}, all deliberate:
 * - `Task`/`TaskOutput`/`TaskStop` are included. A review is one focused pass
 *   over one diff; a scoper or researcher fans out over a whole codebase and
 *   needs subagents to do it without exhausting its context.
 * - `Skill` and `Monitor` are included, because these personas are expected to
 *   invoke the repository's own skills (`/research`, `/to-spec`, `/grilling`).
 * - `mcp__cyrus-tools` and `mcp__cyrus-docs` are included; a review only ever
 *   needs `mcp__linear`.
 *
 * `mcp__linear` stays, for the same reason it stays for a review: a read-only
 * persona must still claim its ticket, post its answer, and update the map.
 * That is a write to the issue tracker, never to code.
 *
 * Pair this with {@link REVIEW_DISALLOWED_TOOLS} as the deny layer — a deny
 * rule beats an allow rule, so the write tools stay blocked even when a
 * repository merges its own `allowedTools` in.
 */
export const READONLY_CODE_TOOLS = [
	// Read-only code access. `Glob` and `Grep` are the two the Slack default
	// was missing, and the two an investigator cannot work without.
	"Read",
	"Glob",
	"Grep",

	// Read-only history inspection. `git`/`gh` subcommands are enumerated
	// individually — `Bash(git:*)` would also permit `git push`/`git commit`.
	"Bash(git log:*)",
	"Bash(git diff:*)",
	"Bash(git show:*)",
	"Bash(git status:*)",
	"Bash(git blame:*)",
	"Bash(gh pr view:*)",
	"Bash(gh pr diff:*)",

	// Web
	"WebFetch",
	"WebSearch",

	// Subagents + task lifecycle. Investigation fans out; these mutate task
	// tracking only, never code.
	"Task",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Discovery — `Skill` is what lets a persona defer to the repository's own
	// `/research`, `/to-spec` or `/grilling` skill instead of improvising.
	"Skill",
	"ToolSearch",
	"Monitor",

	// Workspace MCP servers — read the issue, post the answer, update the map.
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
] as const;

/**
 * Platform identifier used by callers that want to resolve a default list
 * dynamically. Keeps platform-string typos out of the call sites.
 */
export type AllowedToolsPlatform = "linear" | "slack" | "github";

/**
 * Resolve the default allowed-tool list for a platform.
 */
export function getDefaultAllowedTools(
	platform: AllowedToolsPlatform,
): readonly string[] {
	switch (platform) {
		case "linear":
			return LINEAR_DEFAULT_ALLOWED_TOOLS;
		case "slack":
			return SLACK_DEFAULT_ALLOWED_TOOLS;
		case "github":
			return GITHUB_DEFAULT_ALLOWED_TOOLS;
	}
}
