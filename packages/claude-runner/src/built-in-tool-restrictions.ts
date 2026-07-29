import {
	commandMatchesAllowedBash,
	grantsUnrestrictedBash,
	MUTATING_BASH_DENY_RULES,
	WRITE_BUILT_IN_DENY_RULES,
} from "cyrus-core";
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
 * 2. **Argument-narrowed grants on mutating tools are dropped — except
 *    `Bash`.** An entry like `Edit(src/**)` reads as "only these paths", but
 *    the narrowing is *not enforceable*: `allowedTools` patterns only
 *    auto-approve, they never deny. Granting `Edit` because of such an entry
 *    would hand a "read-only" persona arbitrary writes. Since the intent is
 *    clearly narrower than full access and the narrowing cannot be honoured,
 *    the tool is withheld entirely.
 *
 *    `Bash` is the exception, because it is the one mutating tool whose
 *    narrowing Cyrus *can* honour. `ClaudeRunner` enforces scoped `Bash(...)`
 *    grants itself in its `canUseTool` callback, using the shared shell matcher
 *    in `cyrus-core` (`commandMatchesAllowedBash`) that checks every command in
 *    a chain rather than just the first word. Withholding `Bash` here instead
 *    was silently wrong: a `readOnly` reviewer whose whole allow-list is
 *    `Bash(git diff:*)`-shaped got no shell at all, so it reviewed the files at
 *    PR head with no idea what had changed — and said nothing about it (CYR-20).
 *
 *    This is only safe because `ClaudeRunner` installs that callback
 *    unconditionally and keeps `Bash` out of the `allowedTools` it hands the
 *    SDK, so no Bash call can be auto-approved before the callback runs. If you
 *    change either of those, this exception stops being sound.
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
 * Mutating tools whose argument-narrowed grants Cyrus can actually enforce, and
 * which are therefore granted rather than withheld (rule 2 above).
 *
 * Only `Bash`: `ClaudeRunner.createCanUseToolCallback` checks each shell
 * command against the grants via `commandMatchesAllowedBash`. There is no
 * equivalent enforcement for `Edit`/`Write`/`NotebookEdit` path narrowing, so
 * those still fail closed.
 */
const ENFORCEABLY_NARROWED_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

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
 *
 * The empty case is the one worth checking rather than assuming, because if the
 * SDK falsy-checked `tools` then `[]` — the strictest possible input — would
 * silently become the most permissive output. It does not. From the SDK's argv
 * builder (`sdk.mjs`, 0.3.220):
 *
 * ```js
 * if (tools !== undefined)
 *   if (Array.isArray(tools))
 *     if (tools.length === 0) args.push("--tools", "");
 *     else args.push("--tools", tools.join(","));
 * ```
 *
 * `[]` becomes an explicit `--tools ""` — no built-in tools — and only
 * `undefined` skips the flag. So both ends of the range fail in the safe
 * direction. Asserted in `built-in-tool-restrictions.test.ts`; re-check it when
 * the SDK is bumped.
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
			!ENFORCEABLY_NARROWED_TOOLS.has(name) &&
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

/**
 * Extract the representative command a `Bash(prefix:*)` deny rule stands for,
 * so it can be tested against the session's actual grants.
 *
 * `Bash(git commit:*)` -> `git commit`. Returns null for anything that is not
 * a scoped `Bash(...)` rule.
 */
function denyRuleCommand(rule: string): string | null {
	const match = TOOL_ENTRY_PATTERN.exec(rule.trim());
	if (!match || match[1] !== "Bash") {
		return null;
	}
	const argument = match[2];
	if (argument === undefined || isUnrestrictedArgument(argument)) {
		return null;
	}
	return argument.replace(/:\*$/, "").trim();
}

/**
 * Derive the SDK `disallowedTools` option from an `allowedTools` list.
 *
 * ## Why this sits next to `deriveBuiltInTools`
 *
 * `tools` (what the model can see) and `disallowedTools` (what is refused
 * regardless) answer the same question — "what may this persona do?" — from
 * the same input. Deriving them in one place is what stops them drifting: a
 * persona cannot gain a mutating tool in one list without losing it in the
 * other, because both are computed from `allowedTools` by the same rules.
 *
 * It matters that this is a second layer rather than a nicer `tools`. Measured
 * on the real SDK (CYR-25), `tools` and `canUseTool` are both bypassable — a
 * read-only command classifier **inside Claude Code** pre-approves commands it
 * considers non-mutating before the callback runs, and settings-file allow
 * rules can shadow it invisibly. Deny rules are evaluated before both.
 *
 * That pre-approval is **not** the sandbox: it fires with no `sandbox` key
 * configured at all, so it cannot be turned off from Cyrus's side. See the
 * measured table in `cyrus-core`'s `REVIEW_DISALLOWED_TOOLS` docs.
 *
 * ## Rules
 *
 * 1. **No allow-list means no restriction.** `undefined` is the explicit "not
 *    configured" signal, exactly as in {@link deriveBuiltInTools}. Returns `[]`.
 *
 * 2. **An unrestricted builder stays unclamped.** A bare `Bash` / `Bash(*)`
 *    grant means unrestricted *by intent* — the builder personas that have to
 *    commit, push and open PRs. Narrowing them here would break the product's
 *    main path to make a restricted persona marginally tidier.
 *
 * 3. **Never deny what the allow-list actually granted.** Deny beats allow
 *    everywhere, so emitting a rule that contradicts an explicit grant would
 *    silently revoke it. Each candidate `Bash(...)` deny is tested against the
 *    session's own grants with the shared matcher, and skipped if permitted —
 *    a reviewer granted `Bash(git commit:*)` keeps it.
 *
 * 4. **MCP tools are never denied.** `mcp__linear` is how a read-only session
 *    reports its results; a reviewer that cannot post its verdict is useless.
 *    Nothing here emits an `mcp__*` rule.
 */
export function deriveBuiltInDisallowedTools(
	allowedTools: readonly string[] | undefined,
): string[] {
	// Rule 1: not configured — do not restrict.
	if (allowedTools === undefined) {
		return [];
	}

	// Rule 2: unrestricted by intent — leave builders alone.
	if (grantsUnrestrictedBash(allowedTools)) {
		return [];
	}

	const granted = new Set(
		allowedTools.map((entry) => {
			const match = TOOL_ENTRY_PATTERN.exec(entry.trim());
			return match?.[1] ?? "";
		}),
	);

	const denied: string[] = [];

	// Write-capable built-ins the allow-list did not grant.
	for (const tool of WRITE_BUILT_IN_DENY_RULES) {
		if (!granted.has(tool)) {
			denied.push(tool);
		}
	}

	// Mutating shell commands, minus anything this session was actually granted
	// (rule 3). `bashGrants` is the same slice `ClaudeRunner` enforces through
	// `canUseTool`, so the two layers agree on what the grants mean.
	const bashGrants = allowedTools.filter((entry) =>
		entry.trim().startsWith("Bash"),
	);
	for (const rule of MUTATING_BASH_DENY_RULES) {
		const command = denyRuleCommand(rule);
		if (command && commandMatchesAllowedBash(command, bashGrants)) {
			continue;
		}
		denied.push(rule);
	}

	return denied;
}
