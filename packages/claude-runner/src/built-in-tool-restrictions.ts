import { availableTools } from "./config.js";

/**
 * Derivation of the Claude Agent SDK `tools` option from Cyrus's
 * `allowedTools` list.
 *
 * ## Why this exists
 *
 * `allowedTools` is an **auto-approve** list, not a restriction. From the
 * installed SDK typings (`@anthropic-ai/claude-agent-sdk@0.3.205`,
 * `sdk.d.ts:1328-1335`), verbatim:
 *
 * > List of tool names that are auto-allowed without prompting for permission.
 * > These tools will execute automatically without asking the user for
 * > approval. To restrict which tools are available, use the `tools` option
 * > instead.
 *
 * Cyrus historically never set `tools`, so every session — including the
 * `readOnly` presets used by research/review personas — had the full built-in
 * toolset (`Write`, `Edit`, `Bash`, `NotebookEdit`) in the model's context.
 * The `canUseTool` callback in `ClaudeRunner` blanket-allows every tool except
 * `AskUserQuestion`, so nothing downstream caught it either. The SDK itself
 * warns about this shape at runtime (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`:
 * "Bare allowedTools entries auto-approve the whole tool before the callback
 * is consulted").
 *
 * `tools` is the real lever: it sets the base set of built-in tools that exist
 * in the model's context at all. A tool that is not in the set cannot be
 * called, cannot be auto-approved, and never reaches `canUseTool`.
 *
 * ## MCP tools are deliberately untouched
 *
 * `tools` governs the **built-in** set only — the SDK describes it as "the base
 * set of available built-in tools" and the CLI's `--tools` help says "from the
 * built-in set". MCP tools are unaffected: restricting `tools` to
 * `['Read','Grep','Glob']` leaves every `mcp__*` tool reachable. That is what
 * keeps `mcp__linear` working for read-only reviewer personas, which would
 * otherwise be useless (they could read code but not report back).
 *
 * The corollary is that `tools` can never *restrict* an MCP tool. MCP access
 * stays governed by `mcpServers` / `mcpConfig` and `disallowedTools`, so
 * `mcp__*` entries are skipped here rather than being mapped into `tools`
 * (where they would be silently ignored anyway).
 *
 * ## Fail-closed rules
 *
 * 1. **Unknown tool names are dropped, not passed through.** The SDK silently
 *    ignores names it does not recognise, so forwarding them would give the
 *    false impression of a grant. Anything Cyrus does not recognise is not
 *    granted.
 * 2. **Argument-narrowed grants on mutating tools are dropped.** An entry like
 *    `Bash(git -C * pull)` reads as "only this command", but the narrowing is
 *    *not enforceable*: `allowedTools` patterns only auto-approve, they never
 *    deny. Granting `Bash` because of such an entry would hand a "read-only"
 *    persona an arbitrary shell — and therefore arbitrary writes. Since the
 *    intent is clearly narrower than full access and the narrowing cannot be
 *    honoured, the tool is withheld entirely.
 *
 *    Narrowing on non-mutating tools (notably `Read(/path/**)`, which
 *    `ClaudeRunner` generates from `allowedDirectories`) is safe to ignore:
 *    the tool cannot mutate state regardless of which paths were intended.
 */

/** Strip an optional `(argument)` suffix: `Read(**)` -> `Read`. */
const TOOL_ENTRY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/s;

/**
 * Built-in tools that can modify the filesystem or execute arbitrary code.
 * Argument-narrowed grants on these fail closed (see rule 2 above).
 */
export const MUTATING_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
	"Bash",
	"Edit",
	"Write",
	"NotebookEdit",
]);

/**
 * Read-only search tools granted alongside `Read`.
 *
 * These are not in `availableTools` and so never appear in a Cyrus
 * `allowedTools` list, but the SDK notes that they must be requested
 * explicitly: "native builds may provide search via Bash `find`/`grep`
 * instead of the dedicated Grep/Glob tools. List Grep/Glob here or in
 * `allowedTools` to get them." Without them, a read-only session that has also
 * (correctly) lost `Bash` would have no way to search a repository at all.
 * Both are strictly read-only, so granting them alongside `Read` does not
 * widen what a read-only persona can do.
 */
export const READ_ONLY_SEARCH_TOOLS = ["Glob", "Grep"] as const;

/**
 * Built-in tool names Cyrus recognises.
 *
 * Sourced from `availableTools` (the catalog kept in sync with the bundled
 * Claude Code version via `scripts/extract-claude-tools.sh`), plus tools the
 * SDK exposes that the catalog does not list.
 */
export const KNOWN_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
	...availableTools.map((entry) => entry.replace(/\(.*\)$/s, "")),
	...READ_ONLY_SEARCH_TOOLS,
	// Surfaced by the SDK but absent from `availableTools`. Listing them keeps
	// an operator who names them explicitly from silently losing them.
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
]);

/** A grant argument that imposes no real narrowing. */
function isUnrestrictedArgument(argument: string): boolean {
	const trimmed = argument.trim();
	return trimmed === "**" || trimmed === "*" || trimmed === "";
}

export interface DeriveBuiltInToolsOptions {
	/**
	 * Keep `AskUserQuestion` available. Setting `tools` removes it from the
	 * built-in set, which would break `ClaudeRunner`'s `canUseTool` interception
	 * of that tool, so callers that wire an `onAskUserQuestion` handler must opt
	 * back in.
	 */
	includeAskUserQuestion?: boolean;
	/** Optional sink for fail-closed decisions worth surfacing to operators. */
	onDropped?: (entry: string, reason: string) => void;
}

/**
 * Derive the SDK `tools` option (the base set of built-in tools) from an
 * `allowedTools` list.
 *
 * Returns `undefined` when `allowedTools` is `undefined`, which leaves the SDK
 * default (all built-in tools) in place — an explicit "no list configured, do
 * not restrict" signal, distinct from an empty list meaning "grant nothing".
 */
export function deriveBuiltInTools(
	allowedTools: readonly string[] | undefined,
	options: DeriveBuiltInToolsOptions = {},
): string[] | undefined {
	if (allowedTools === undefined) {
		return undefined;
	}

	const { includeAskUserQuestion = false, onDropped } = options;
	const granted = new Set<string>();

	for (const entry of allowedTools) {
		// MCP tools are not governed by `tools` — they stay reachable regardless
		// and are controlled via `mcpServers` / `disallowedTools`.
		if (entry.startsWith("mcp__")) {
			continue;
		}

		const match = TOOL_ENTRY_PATTERN.exec(entry.trim());
		if (!match) {
			onDropped?.(entry, "unparseable tool entry");
			continue;
		}

		const name = match[1] as string;
		const argument = match[2];

		if (!KNOWN_BUILT_IN_TOOLS.has(name)) {
			onDropped?.(entry, `unrecognized built-in tool "${name}"`);
			continue;
		}

		if (
			argument !== undefined &&
			MUTATING_BUILT_IN_TOOLS.has(name) &&
			!isUnrestrictedArgument(argument)
		) {
			onDropped?.(
				entry,
				`argument-narrowed grant on mutating tool "${name}" cannot be enforced by the SDK (allowedTools only auto-approves, it never denies), so the tool is withheld entirely`,
			);
			continue;
		}

		granted.add(name);
	}

	if (granted.has("Read")) {
		for (const searchTool of READ_ONLY_SEARCH_TOOLS) {
			granted.add(searchTool);
		}
	}

	if (includeAskUserQuestion) {
		granted.add("AskUserQuestion");
	}

	return [...granted].sort();
}
