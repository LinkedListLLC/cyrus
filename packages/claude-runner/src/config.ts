/**
 * Claude CLI configuration helpers
 *
 * Skills Documentation:
 * - Claude Code CLI: https://code.claude.com/docs/en/skills
 * - Agent SDK: https://platform.claude.com/docs/en/agent-sdk/skills
 *
 * IMPORTANT: The `allowed-tools` frontmatter field in SKILL.md is only supported
 * when using Claude Code CLI directly. It does not apply when using Skills through
 * the SDK. When using the SDK, control tool access through the main `allowedTools`
 * option in your query configuration.
 */

/**
 * List of all available tools in Claude Code.
 *
 * ## Keep this in sync with the bundled Claude Code — it is load-bearing
 *
 * `KNOWN_BUILT_IN_TOOLS` is derived from this array, and `deriveBuiltInTools`
 * **drops** any name not in it. Since `tools` is now the option that decides
 * what the model can see at all, a name this list has not heard of is withheld
 * from every session rather than merely left off an auto-approve list. A stale
 * catalog therefore costs capability, silently. That is the price of the
 * fail-closed rule, and it is why `CLAUDE.md` note 7 makes the refresh
 * mandatory on every SDK bump:
 *
 *     ./scripts/extract-claude-tools.sh
 *
 * ## Last verified
 *
 * `@anthropic-ai/claude-agent-sdk@0.3.220` (Claude Code 2.1.220), 2026-07-29.
 * The script's init block reported 28 tools. Every one of them is in this list —
 * nothing 0.3.220 offers is being withheld.
 *
 * One entry here is *not* in that init block: `RemoteTrigger`. It is kept
 * deliberately. It is surfaced to live Cyrus sessions as a deferred tool (it
 * appears in the session tool list at runtime), so it is gated rather than gone,
 * and the init block of a bare `claude -p` does not enumerate it. Keeping a name
 * that turns out not to exist costs nothing — the grant is a no-op — whereas
 * dropping a name that does exist withholds the tool.
 */
export const availableTools = [
	// File system tools
	"Read(**)",
	"Edit(**)",
	"Write(**)",

	// Execution tools
	"Bash",
	"Task",

	// Web tools
	"WebFetch",
	"WebSearch",

	// Task management
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",

	// Notebook tools
	"NotebookEdit",

	// Skills - enables Claude to use packaged capabilities (SKILL.md files)
	// See: https://platform.claude.com/docs/en/agent-sdk/skills
	"Skill",

	// User interaction tools
	"SendMessage",
	"PushNotification",

	// Plan and worktree management
	"EnterWorktree",
	"ExitWorktree",

	// Scheduling and cron tools
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring and task lifecycle
	"Monitor",
	"RemoteTrigger",
	"TaskOutput",
	"TaskStop",

	// Tool discovery
	"ToolSearch",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",
] as const;

export type ToolName = (typeof availableTools)[number];

/**
 * Default read-only tools that are safe to enable
 * Note: Task tools are included as they only modify task tracking, not actual code files
 * Note: Skill is included as it enables Claude to use Skills which are packaged capabilities
 */
export const readOnlyTools: ToolName[] = [
	"Read(**)",
	"WebFetch",
	"WebSearch",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"Task",
	"Skill",
	"Monitor",
	"TaskOutput",
	"ToolSearch",
];

/**
 * Tools that can modify the file system or state
 */
export const writeTools: ToolName[] = [
	"Edit(**)",
	"Write(**)",
	"Bash",
	"NotebookEdit",
];

/**
 * Get a safe set of tools for read-only operations
 */
export function getReadOnlyTools(): string[] {
	return [...readOnlyTools];
}

/**
 * Get all available tools
 */
export function getAllTools(): string[] {
	return [...availableTools];
}

/**
 * Get all tools except Bash (safer default for repository configuration)
 */
export function getSafeTools(): string[] {
	return [...availableTools].filter((t) => t !== "Bash");
}

/**
 * Get coordinator tools - all tools except those that can edit files
 * Excludes: Edit, Write, NotebookEdit (no file/content modification)
 * Used by orchestrator role for coordination without direct file modification
 */
export function getCoordinatorTools(): string[] {
	return [...availableTools].filter(
		(t) => t !== "Edit(**)" && t !== "Write(**)" && t !== "NotebookEdit",
	);
}
