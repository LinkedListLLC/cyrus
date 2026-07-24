/**
 * Translate Cyrus's Claude-shaped tool restrictions into Grok permission rules.
 *
 * Cyrus expresses tool policy in Claude Code's vocabulary (`Read(**)`,
 * `Bash(git:*)`, `mcp__linear`, plus presets like `readOnly`). Grok has its own
 * permission-rule system that is *deliberately* Claude-compatible, but not
 * identical, and the mismatches fail quietly:
 *
 *   - `mcp__server__tool` NEVER matches a Grok MCP call. Grok tool names carry
 *     no `mcp__` prefix; the rule has to be written `MCPTool(server__tool)`.
 *     Passed through verbatim, a review persona's `mcp__linear` silently grants
 *     nothing — and the reviewer can't post its findings back to Linear.
 *   - Rules naming a tool Grok doesn't know (`Task`, `Skill`, `TaskCreate`, …)
 *     are skipped with a warning rather than failing the load, so a policy can
 *     look applied while most of it evaporated.
 *
 * Enforcement uses **deny** rules rather than an allow-list, because only deny
 * is honoured in every permission mode: "always-approve mode short-circuits the
 * pipeline after step 2 — deny rules, hooks, and shell ask rules still apply".
 * An allow-list alone would be inert under the `--always-approve` the runner
 * passes for unattended sessions, and Grok's deny-by-default mode (`dontAsk`)
 * cannot be turned on from the CLI — `--permission-mode dontAsk` is accepted but
 * does not enable that policy; it needs `defaultMode` in `.claude/settings.json`,
 * which we will not write into the user's repository worktree.
 *
 * So: when an allow-list is in force, every mutating tool class *not* in it is
 * denied explicitly. That is the same shape as Grok's own documented read-only
 * reviewer example (allow read + grep, deny edit + bash).
 *
 * Reference: the Grok CLI's bundled `docs/user-guide/22-permissions-and-safety.md`
 * ("Tool Names", "MCP Rules", "Example Configurations").
 */

/**
 * Tool names Grok's rule parser recognizes. Anything else is dropped by Grok
 * with a warning, so we surface it instead of pretending it applied.
 */
const RECOGNIZED_TOOL_NAMES = new Set([
	"Bash",
	"Read",
	"NotebookRead",
	"Edit",
	"Write",
	"NotebookEdit",
	"Grep",
	"Glob",
	"MCPTool",
	"WebFetch",
	"WebSearch",
	"*",
]);

/**
 * Tool classes that can modify the workspace. When an allow-list omits one of
 * these, it is denied outright — this is what makes a `readOnly` preset real
 * rather than advisory.
 */
const MUTATING_TOOL_NAMES = ["Edit", "Write", "NotebookEdit", "Bash"] as const;

export interface GrokToolPolicy {
	/** `--allow` rules to pass to the Grok CLI. */
	allow: string[];
	/** `--deny` rules to pass to the Grok CLI. Enforced in every mode. */
	deny: string[];
	/** Input entries with no Grok equivalent; dropped, reported for logging. */
	untranslated: string[];
	/**
	 * True when the allow-list scopes Bash to specific commands (e.g.
	 * `Bash(git:*)`). Grok evaluates deny before allow, so a blanket `Bash` deny
	 * would also kill the permitted commands, and the narrower "only these bash
	 * commands" policy is not expressible with rules alone — it needs `dontAsk`
	 * or a PreToolUse hook. Bash is therefore left unrestricted and the caller
	 * warns, rather than silently over- or under-blocking.
	 */
	scopedBashUnenforceable: boolean;
}

/** Split `Name(args)` into its head and the parenthesised remainder. */
function splitRule(rule: string): { head: string; args?: string } {
	const match = rule.match(/^([A-Za-z*][A-Za-z0-9_]*)(\((.*)\))?$/s);
	if (!match?.[1]) {
		return { head: "" };
	}
	return { head: match[1], args: match[3] };
}

/**
 * Translate one Cyrus/Claude tool rule into its Grok equivalent.
 * Returns null when Grok has no equivalent.
 */
export function translateToolRule(rule: string): string | null {
	const trimmed = rule.trim();
	if (!trimmed) {
		return null;
	}

	// `mcp__server` / `mcp__server__tool` → `MCPTool(server__tool)`.
	// Cyrus grants a whole server (`mcp__linear`); Grok needs an explicit glob.
	const mcp = trimmed.match(/^mcp__([A-Za-z0-9_.-]+?)(?:__(.+))?$/);
	if (mcp?.[1]) {
		const server = mcp[1];
		const tool = mcp[2] ?? "*";
		return `MCPTool(${server}__${tool})`;
	}

	const { head } = splitRule(trimmed);
	if (head && RECOGNIZED_TOOL_NAMES.has(head)) {
		// Already Grok-compatible, including the `Bash(git:*)` prefix form.
		return trimmed;
	}

	return null;
}

/**
 * Build the Grok permission rules for a session from Cyrus's tool config.
 *
 * @param allowedTools Cyrus `allowedTools` (empty/undefined = unrestricted)
 * @param disallowedTools Cyrus `disallowedTools`
 */
export function translateToolRules(
	allowedTools?: string[],
	disallowedTools?: string[],
): GrokToolPolicy {
	const untranslated: string[] = [];
	const allow: string[] = [];
	const deny: string[] = [];

	for (const entry of allowedTools ?? []) {
		const translated = translateToolRule(entry);
		if (translated) {
			if (!allow.includes(translated)) {
				allow.push(translated);
			}
		} else if (entry.trim()) {
			untranslated.push(entry.trim());
		}
	}

	for (const entry of disallowedTools ?? []) {
		const translated = translateToolRule(entry);
		if (translated) {
			if (!deny.includes(translated)) {
				deny.push(translated);
			}
		} else if (entry.trim()) {
			untranslated.push(entry.trim());
		}
	}

	// No allow-list means "unrestricted" in Cyrus — only explicit denies apply.
	const restricted = allow.length > 0;
	let scopedBashUnenforceable = false;

	if (restricted) {
		const allowedHeads = new Set(
			allow.map((rule) => splitRule(rule).head).filter(Boolean),
		);
		// A scoped Bash grant (`Bash(git:*)`) cannot coexist with a blanket Bash
		// deny, because deny wins regardless of specificity.
		const bashRules = allow.filter((rule) => splitRule(rule).head === "Bash");
		scopedBashUnenforceable = bashRules.some((rule) => rule !== "Bash");

		for (const tool of MUTATING_TOOL_NAMES) {
			if (allowedHeads.has(tool) || allowedHeads.has("*")) {
				continue;
			}
			if (tool === "Bash" && scopedBashUnenforceable) {
				continue;
			}
			if (!deny.includes(tool)) {
				deny.push(tool);
			}
		}
	}

	return { allow, deny, untranslated, scopedBashUnenforceable };
}
