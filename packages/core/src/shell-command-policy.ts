/**
 * Engine-agnostic matching of shell commands against Claude-shaped scoped Bash
 * grants (`Bash(git diff:*)`).
 *
 * These primitives were written for the Grok runner (CYR-17), where the ACP
 * permission handshake is answered client-side. They turned out to be needed
 * verbatim on the Claude path too (CYR-20): a `readOnly` Claude persona carries
 * the same `Bash(git diff:*)`-shaped grants, and enforcing them in
 * `ClaudeRunner`'s `canUseTool` callback needs exactly this matching. Nothing
 * here is specific to either engine — it is string matching over a shell
 * command and a list of grant patterns — so it lives in `cyrus-core` and both
 * runners import it. `cyrus-claude-runner` does not (and should not) depend on
 * `cyrus-grok-runner`.
 *
 * The two runners must agree: a command refused on Grok has to be refused on
 * Claude, or the choice of engine silently changes the security posture.
 */

/** Split `Name(args)` into its head and the parenthesised remainder. */
function splitRule(rule: string): { head: string; args?: string } {
	const match = rule.match(/^([A-Za-z*][A-Za-z0-9_]*)(\((.*)\))?$/s);
	if (!match?.[1]) {
		return { head: "" };
	}
	return { head: match[1], args: match[3] };
}

/** What a scan of a shell command found in it. */
export interface ShellCommandScan {
	/** Every command the string would run, in order. */
	segments: string[];
	/**
	 * True when the string redirects a stream to or from a file, or uses
	 * process substitution (`<(…)`, `>(…)`).
	 *
	 * A redirection is a write that no segment names. `git diff HEAD > ~/.bashrc`
	 * splits into the single segment `git diff HEAD > ~/.bashrc`, which a
	 * `Bash(git diff:*)` prefix grant matches — so a session allowed to read a
	 * diff could write any file on the box. Segment matching cannot see this,
	 * because the capability is in the operator, not in the command name.
	 */
	hasRedirection: boolean;
}

/**
 * Scan a shell command for the commands it runs and the redirections it opens.
 *
 * Matching a grant against the raw string only ever examines the *first*
 * command: under `Bash(git diff:*)`, `git diff HEAD && sed -i s/a/b/ f` reads as
 * an allowed `git diff` — the very in-place-edit escape this policy exists to
 * close, caught only when it happens to be the first word. So every command has
 * to be checked, which means every command has to be found first: the operators
 * `;` `&&` `||` `|` `&` and newlines separate them, and `$(…)`, backticks and
 * `<(…)`/`>(…)` hide more of them inside an otherwise-innocent argument.
 *
 * Redirections are reported rather than split out. They run no new command, so
 * there is no segment to match them against — but `>` is the same capability as
 * the `Bash(tee:*)` we deny, in one character. Callers enforcing a narrowed
 * grant refuse on `hasRedirection`; see {@link commandMatchesAllowedBash}.
 *
 * Quote-aware, because an operator inside quotes is data, not a separator.
 * Returns null when the command cannot be parsed — an unterminated quote or
 * substitution — so the caller can fail closed rather than guess.
 */
export function scanShellCommand(command: string): ShellCommandScan | null {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasRedirection = false;

	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};

	/**
	 * Index of the `)` closing the `(` at `open`, or -1.
	 *
	 * Quote- and escape-aware: `$(echo ")")` closes at the last `)`, not at the
	 * quoted one. Getting this wrong truncates the body, which changes what the
	 * nested parse sees.
	 */
	const findClose = (open: number): number => {
		let depth = 0;
		let inner: '"' | "'" | null = null;
		for (let j = open; j < command.length; j++) {
			const c = command[j];
			if (c === "\\" && inner !== "'") {
				j++;
				continue;
			}
			if (inner) {
				if (c === inner) inner = null;
				continue;
			}
			if (c === '"' || c === "'") {
				inner = c;
				continue;
			}
			if (c === "(") depth++;
			else if (c === ")" && --depth === 0) return j;
		}
		return -1;
	};

	/** Index of the next backtick that is not escaped, or -1. */
	const findBacktick = (from: number): number => {
		for (let j = from; j < command.length; j++) {
			if (command[j] === "\\") {
				j++;
				continue;
			}
			if (command[j] === "`") return j;
		}
		return -1;
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		const next = command[i + 1];

		// An escaped character is data, never an operator or a quote.
		if (char === "\\" && quote !== "'") {
			if (i + 1 >= command.length) return null;
			current += char + next;
			i++;
			continue;
		}

		// Command substitution runs everywhere except inside single quotes.
		// `<(…)` and `>(…)` run a command exactly as `$(…)` does, so they get
		// the same treatment: the inner command is extracted and matched. They
		// also open a pipe, so they count as a redirection.
		const isProcessSubstitution =
			(char === "<" || char === ">") && next === "(";
		if (
			quote !== "'" &&
			(char === "`" || (char === "$" && next === "(") || isProcessSubstitution)
		) {
			const inner =
				char === "`"
					? (() => {
							const end = findBacktick(i + 1);
							return end === -1
								? null
								: { body: command.slice(i + 1, end), end };
						})()
					: (() => {
							const end = findClose(i + 1);
							return end === -1
								? null
								: { body: command.slice(i + 2, end), end };
						})();
			if (!inner) return null;
			const nested = scanShellCommand(inner.body);
			if (nested === null) return null;
			segments.push(...nested.segments);
			if (nested.hasRedirection || isProcessSubstitution) hasRedirection = true;
			// The substitution's *value* is an argument to the outer command.
			current += " ";
			i = inner.end;
			continue;
		}

		if (quote) {
			if (char === quote) quote = null;
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}

		if (char === "\n" || char === ";") {
			flush();
			continue;
		}
		if ((char === "&" || char === "|") && next === char) {
			flush();
			i++;
			continue;
		}
		if (char === "|") {
			flush();
			continue;
		}
		if (char === "&") {
			// `2>&1` and `&>file` are redirections, not a background operator.
			if (command[i - 1] === ">" || next === ">") {
				hasRedirection = true;
				current += char;
				continue;
			}
			flush();
			continue;
		}
		if (char === "<" || char === ">") {
			// `>`, `>>`, `<`, `<<` and `<<<` all move a stream between a command
			// and a file. None of them starts a new command, so the operator and
			// its target stay in the current segment; the flag is what the caller
			// acts on.
			hasRedirection = true;
			current += char;
			continue;
		}

		current += char;
	}

	if (quote) return null; // unterminated quote
	flush();
	return { segments, hasRedirection };
}

/**
 * Split a shell command into the individual commands it will actually run.
 *
 * Thin wrapper over {@link scanShellCommand} for callers that only need the
 * commands. It discards `hasRedirection`, so a caller enforcing a narrowed
 * grant should use the scan directly and fail closed on it.
 */
export function splitShellCommands(command: string): string[] | null {
	return scanShellCommand(command)?.segments ?? null;
}

/**
 * Arguments that make an otherwise read-only command write a file.
 *
 * `git diff --output=/root/.bashrc` opens no redirection and runs no second
 * command, so neither the segment split nor `hasRedirection` sees it: the
 * segment is `git diff --output=…`, which a `Bash(git diff:*)` prefix grant
 * matches. The write is in an option, and options are per-tool.
 *
 * This list is therefore **not** a boundary, and must not be read as one. It
 * covers the flags that the granted git/gh inspection commands actually accept,
 * so that the shipped read-only presets do not have an obvious one-flag escape.
 * A tool with a differently-spelled output flag still gets through. See
 * {@link commandMatchesAllowedBash} for what this layer is and is not.
 */
const FILE_WRITING_ARGUMENT =
	/^(?:-o|-O|--out|--output|--output-file|--outfile|--output-directory|--log-file|--dump-header|--write-out)(?:=|$)/;

/** Does any argument of this segment name a file to write? */
function writesFileByArgument(segment: string): boolean {
	return segment
		.split(/\s+/)
		.some((token) => FILE_WRITING_ARGUMENT.test(token.replace(/^["']/, "")));
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile a scoped Bash grant's argument into a matcher.
 *
 * `Bash(git diff:*)` and `Bash(git diff *)` are prefix grants — Claude's `:*`
 * suffix and a trailing `*` both read as "…and any arguments". A `*` anywhere
 * *else* is a wildcard standing in for one argument, which is exactly the form
 * the shipped Slack preset uses: `Bash(git -C * pull)`. Stripping only the
 * suffix and then comparing literally left that `*` as a real asterisk, so the
 * grant matched nothing at all — not even the command it names.
 *
 * Returns "match-all" for a grant that permits every command (`Bash(*)`).
 */
export function compileBashPattern(args: string): RegExp | "match-all" {
	let pattern = args.trim().replace(/\*{2,}/g, "*");
	let prefix = false;
	if (pattern.endsWith(":*")) {
		pattern = pattern.slice(0, -2).trim();
		prefix = true;
	} else if (pattern.endsWith("*")) {
		pattern = pattern.slice(0, -1).trim();
		prefix = true;
	}
	if (!pattern) return "match-all";

	const body = pattern
		.split("*")
		.map((literal) => literal.replace(REGEXP_SPECIALS, "\\$&"))
		.join("\\S*");
	return new RegExp(prefix ? `^${body}(?:\\s[\\s\\S]*)?$` : `^${body}$`);
}

/**
 * Does a shell command match the allow-list's scoped Bash grants?
 *
 * Every command the string would run must be named by a grant — a chain is only
 * as permitted as its least-permitted link. On top of that the command must not
 * redirect a stream, and no segment may carry a file-writing option flag,
 * because both write files that no grant ever named.
 *
 * ## What this layer is worth
 *
 * It is a shell-string matcher, and a shell-string matcher is best-effort. It
 * refuses the routes we know about: a second command, a substitution, a
 * redirection, and the output flags the granted commands accept. It cannot
 * promise that a command whose *name* looks read-only is read-only, because
 * that is a property of the tool, not of its name — every `git` subcommand this
 * repository grants takes some spelling of "write the result to a file".
 *
 * So do not read a narrowed `Bash(...)` grant as "this session cannot write".
 * It is a strong filter over an intentionally small set of granted commands.
 * The boundary that does not depend on knowing every flag is the OS sandbox
 * (`sandbox.filesystem` — bubblewrap on Linux, the macOS sandbox), which
 * refuses the write itself rather than the string that asks for it.
 *
 * @param allow Tool rules in Claude's vocabulary. Non-`Bash` entries are
 * ignored, so the caller can pass a whole `allowedTools` list.
 */
export function commandMatchesAllowedBash(
	command: string,
	allow: readonly string[],
): boolean {
	const matchers: RegExp[] = [];
	for (const rule of allow) {
		const { head, args } = splitRule(rule.trim());
		if (head !== "Bash") continue;
		// A bare `Bash` grant permits everything, chains included.
		if (!args) return true;
		const compiled = compileBashPattern(args);
		if (compiled === "match-all") return true;
		matchers.push(compiled);
	}
	if (matchers.length === 0) return false;

	const scan = scanShellCommand(command);
	// Unparseable, or nothing recognisable to run: we cannot say what this
	// would do, so we refuse it.
	if (scan === null || scan.segments.length === 0) return false;
	// A redirection writes a file that no grant named. Refusing it costs a
	// narrowed session nothing — an inspection command has no reason to
	// redirect, and `2>/dev/null` is not worth a hole the width of `>`.
	if (scan.hasRedirection) return false;
	if (scan.segments.some(writesFileByArgument)) return false;
	return scan.segments.every((segment) =>
		matchers.some((matcher) => matcher.test(segment)),
	);
}

/**
 * Does this allow-list grant `Bash` without narrowing it?
 *
 * A bare `Bash` (or `Bash(*)` / `Bash(**)`) is the unrestricted builder shape:
 * every command is permitted, so there is nothing to enforce.
 */
export function grantsUnrestrictedBash(allow: readonly string[]): boolean {
	return allow.some((rule) => {
		const { head, args } = splitRule(rule.trim());
		if (head !== "Bash") return false;
		if (args === undefined) return true;
		return compileBashPattern(args) === "match-all";
	});
}

/** Does this allow-list contain any `Bash(...)` grant at all? */
export function hasBashGrant(allow: readonly string[]): boolean {
	return allow.some((rule) => splitRule(rule.trim()).head === "Bash");
}
