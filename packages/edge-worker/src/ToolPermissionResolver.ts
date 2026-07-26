import {
	getAllTools,
	getCoordinatorTools,
	getSafeTools,
} from "cyrus-claude-runner";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import {
	GITHUB_DEFAULT_ALLOWED_TOOLS,
	LINEAR_DEFAULT_ALLOWED_TOOLS,
	SLACK_DEFAULT_ALLOWED_TOOLS,
} from "cyrus-core";

/** Prompt type used for label-based tool/prompt selection */
export type PromptType =
	| "debugger"
	| "builder"
	| "scoper"
	| "orchestrator"
	| "graphite-orchestrator";

/**
 * Unified tool permission resolver for issue, chat, and webhook-triggered
 * sessions.
 *
 * The resolver is **additive only**: it never appends or strips tools after
 * the explicit list is chosen. The per-platform defaults live in cyrus-core
 * (`LINEAR_DEFAULT_ALLOWED_TOOLS`, `SLACK_DEFAULT_ALLOWED_TOOLS`,
 * `GITHUB_DEFAULT_ALLOWED_TOOLS`) and include workspace MCP prefixes
 * (`mcp__linear`, `mcp__cyrus-tools`, etc.) explicitly. Callers that want a
 * tighter list pass `linearAllowedTools` / `slackAllowedTools` /
 * `githubAllowedTools` on `EdgeWorkerConfig`, or set repo-level
 * `allowedTools`. The repo override is a verbatim replacement, not an
 * intersection.
 */
export class ToolPermissionResolver {
	private config: EdgeWorkerConfig;
	private logger: ILogger;

	constructor(config: EdgeWorkerConfig, logger: ILogger) {
		this.config = config;
		this.logger = logger;
	}

	/**
	 * Update the internal config reference (e.g. after hot-reload).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Resolve a tool preset string to an array of tool names.
	 */
	public resolveToolPreset(preset: string | string[]): string[] {
		if (Array.isArray(preset)) {
			return preset;
		}

		switch (preset) {
			case "readOnly":
				// Read-only preset for chat sessions falls back to the Slack default
				// (which encodes the curated read-only set including MCP prefixes).
				return [...SLACK_DEFAULT_ALLOWED_TOOLS];
			case "safe":
				return getSafeTools();
			case "all":
				return getAllTools();
			case "coordinator":
				return getCoordinatorTools();
			default:
				// If it's a string but not a preset, treat it as a single tool
				return [preset];
		}
	}

	/**
	 * Build allowed tools for Slack chat sessions.
	 *
	 * Returns the team-configured `slackAllowedTools` if set, otherwise the
	 * built-in `SLACK_DEFAULT_ALLOWED_TOOLS`. Additionally merges any
	 * user-configured MCP tool entries the caller threads through (used by
	 * `RunnerConfigBuilder` when a repo declares custom MCP server tools).
	 *
	 * @param mcpConfigKeys - Built-in MCP server names. Folded in as
	 *   `mcp__<key>` prefixes only if not already present in the explicit
	 *   list — the defaults already include the standard prefixes, so this
	 *   is purely additive for non-standard servers.
	 * @param userMcpTools - User-configured MCP tool entries from repository
	 *   `allowedTools` (already `mcp__*` prefixed).
	 */
	public buildChatAllowedTools(
		mcpConfigKeys?: string[],
		userMcpTools?: string[],
	): string[] {
		const baseChatTools =
			this.config.slackAllowedTools && this.config.slackAllowedTools.length > 0
				? this.config.slackAllowedTools
				: [...SLACK_DEFAULT_ALLOWED_TOOLS];

		const mcpToolPermissions = (mcpConfigKeys ?? []).map(
			(server) => `mcp__${server}`,
		);

		return Array.from(
			new Set([
				...baseChatTools,
				...mcpToolPermissions,
				...(userMcpTools ?? []),
			]),
		);
	}

	/**
	 * Build allowed tools list for Linear-triggered sessions.
	 *
	 * Accepts a single repository or an array for multi-repo sessions. For
	 * multiple repositories the result is the **union** of each repo's
	 * resolved list (per-repo presets resolved first, then unioned). When no
	 * repos are passed, falls back to the workspace `linearAllowedTools`
	 * (or the Linear platform default when neither is set).
	 */
	public buildAllowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?: PromptType,
	): string[] {
		const repoArray = Array.isArray(repositories)
			? repositories
			: [repositories];

		if (repoArray.length === 0) {
			// Non-empty guard, same as step 4 of `buildAllowedToolsForRepo`:
			// `??` only catches null/undefined, so a configured-but-empty list
			// would pass straight through as an empty allow-list.
			const baseTools = this.config.linearAllowedTools?.length
				? this.config.linearAllowedTools
				: [...LINEAR_DEFAULT_ALLOWED_TOOLS];
			return [...new Set(baseTools)];
		}

		const perRepoTools = repoArray.map((repo) =>
			this.buildAllowedToolsForRepo(repo, promptType),
		);
		const unionTools = [...new Set(perRepoTools.flat())];

		const repoNames = repoArray.map((r) => r.name).join(", ");
		this.logger.debug(
			`Linear tool selection for [${repoNames}]: ${unionTools.length} tools (union of ${repoArray.length} repo(s))`,
		);
		return unionTools;
	}

	/**
	 * Build allowed tools list for GitHub-triggered sessions.
	 *
	 * GitHub `@mentions` target a single repository via a single PR, so this
	 * does not perform multi-repo union — it expects exactly one repo. When
	 * the workspace defines `githubAllowedTools` it is used as the global
	 * default for resolution (in place of `linearAllowedTools`); otherwise
	 * we fall back to `GITHUB_DEFAULT_ALLOWED_TOOLS`. Per-repository
	 * `allowedTools` overrides still take precedence — same priority chain
	 * as Linear, just with a different platform default at the bottom.
	 */
	public buildGithubAllowedTools(
		repository: RepositoryConfig,
		promptType?: PromptType,
	): string[] {
		const platformDefault =
			this.config.githubAllowedTools &&
			this.config.githubAllowedTools.length > 0
				? this.config.githubAllowedTools
				: [...GITHUB_DEFAULT_ALLOWED_TOOLS];

		const originalDefault = this.config.linearAllowedTools;
		this.config.linearAllowedTools = platformDefault;
		try {
			return this.buildAllowedTools(repository, promptType);
		} finally {
			this.config.linearAllowedTools = originalDefault;
		}
	}

	/**
	 * Resolve allowed tools for a single repository (Linear/GitHub priority
	 * chain — chat sessions go through `buildChatAllowedTools`).
	 */
	private buildAllowedToolsForRepo(
		repository: RepositoryConfig,
		promptType?: PromptType,
	): string[] {
		const effectivePromptType =
			promptType === "graphite-orchestrator" ? "orchestrator" : promptType;

		// Priority order:
		// 1. Repository-specific prompt type configuration
		const promptConfig = effectivePromptType
			? repository.labelPrompts?.[effectivePromptType]
			: undefined;
		const promptAllowedTools =
			promptConfig && !Array.isArray(promptConfig)
				? promptConfig.allowedTools
				: undefined;
		if (promptAllowedTools) {
			return this.resolveToolPreset(promptAllowedTools);
		}
		// 2. Global prompt type defaults
		if (
			effectivePromptType &&
			this.config.promptDefaults?.[effectivePromptType]?.allowedTools
		) {
			return this.resolveToolPreset(
				this.config.promptDefaults[effectivePromptType].allowedTools,
			);
		}
		// 3. Repository-level allowed tools (verbatim — no platform-default
		//    merging; if the operator narrows the list, they get the narrow
		//    list). Preset *strings* are still expanded: `resolveToolPreset`
		//    returns an array unchanged, so this stays verbatim for arrays
		//    while `"all"` / `"safe"` / `"readOnly"` / `"coordinator"` mean the
		//    same thing here as they do at steps 1-2. Without this, a preset
		//    string would be taken as one literal tool name and silently
		//    derive to zero built-in tools.
		if (repository.allowedTools) {
			return this.resolveToolPreset(repository.allowedTools);
		}
		// 4. Workspace default allowed tools (the platform default the
		//    surrounding `buildAllowedTools` / `buildGithubAllowedTools`
		//    swapped in, if any).
		//
		//    Guarded on non-empty: an empty array is truthy, so an unguarded
		//    check would return `[]` and make step 5 unreachable, handing the
		//    session an empty allow-list (and, since `tools` derives from
		//    `allowedTools`, no tools at all). "Configured to nothing" is not
		//    a state any caller means to express — it is what an absent
		//    setting used to collapse into.
		if (this.config.linearAllowedTools?.length) {
			return this.config.linearAllowedTools;
		}
		// 5. Final fallback — Linear platform default.
		return [...LINEAR_DEFAULT_ALLOWED_TOOLS];
	}

	/**
	 * Build disallowed tools list from repository and global config.
	 * Accepts a single repository or an array for multi-repo sessions.
	 * For multiple repositories, the result is the intersection — a tool is only
	 * disallowed if ALL repositories disallow it.
	 */
	public buildDisallowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?: PromptType,
	): string[] {
		const repoArray = Array.isArray(repositories)
			? repositories
			: [repositories];

		if (repoArray.length === 0) {
			return this.config.defaultDisallowedTools || [];
		}

		const perRepoTools = repoArray.map((repo) =>
			this.buildDisallowedToolsForRepo(repo, promptType),
		);

		let intersection: string[];
		if (perRepoTools.length === 1) {
			intersection = perRepoTools[0]!;
		} else {
			const firstSet = new Set(perRepoTools[0]!);
			intersection = [...firstSet].filter((tool) =>
				perRepoTools.every((repoTools) => repoTools.includes(tool)),
			);
		}

		if (intersection.length > 0) {
			const repoNames = repoArray.map((r) => r.name).join(", ");
			this.logger.debug(
				`Disallowed tools for [${repoNames}]: ${intersection.length} tools (intersection of ${repoArray.length} repo(s))`,
			);
		}

		return intersection;
	}

	/**
	 * Resolve disallowed tools for a single repository.
	 */
	private buildDisallowedToolsForRepo(
		repository: RepositoryConfig,
		promptType?: PromptType,
	): string[] {
		const effectivePromptType =
			promptType === "graphite-orchestrator" ? "orchestrator" : promptType;

		// Priority order (same as allowedTools).
		//
		// Every rung is guarded on `?.length`, never on truthiness. `[]` is
		// truthy in JavaScript, so a configured-but-empty list at any rung would
		// short-circuit the ladder and make every rung below it unreachable.
		// That exact bug lived on the *allowed* side for two months (CYR-28),
		// where it silently disabled the platform-default fallback. The shape is
		// identical here, so the guard has to be too.
		//
		// 1. Repository-specific prompt type configuration
		const promptConfig = effectivePromptType
			? repository.labelPrompts?.[effectivePromptType]
			: undefined;
		const promptDisallowedTools =
			promptConfig && !Array.isArray(promptConfig)
				? promptConfig.disallowedTools
				: undefined;
		if (promptDisallowedTools?.length) {
			return promptDisallowedTools;
		}
		// 2. Global prompt type defaults
		const promptDefaultDisallowedTools = effectivePromptType
			? this.config.promptDefaults?.[effectivePromptType]?.disallowedTools
			: undefined;
		if (promptDefaultDisallowedTools?.length) {
			return promptDefaultDisallowedTools;
		}
		// 3. Repository-level disallowed tools
		if (repository.disallowedTools?.length) {
			return repository.disallowedTools;
		}
		// 4. Global default disallowed tools
		if (this.config.defaultDisallowedTools?.length) {
			return this.config.defaultDisallowedTools;
		}
		// 5. No built-in default here on purpose.
		//
		// The deny list a restricted persona needs is derived from its own
		// `allowedTools` in `deriveBuiltInDisallowedTools` (claude-runner), not
		// pinned to a fixed list here — a static default could not know whether
		// this session is a read-only reviewer or an unrestricted builder, and
		// denying a builder's `git push` would break the product's main path.
		// An empty list here means "add nothing beyond what is derived", which
		// is the safe default in a way an empty *allow* list was not.
		return [];
	}
}
