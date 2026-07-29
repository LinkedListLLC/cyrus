import { dirname } from "node:path";
import {
	deriveBuiltInDisallowedTools,
	deriveBuiltInTools,
} from "cyrus-claude-runner";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { LogLevel } from "cyrus-core";
import type { PromptType } from "cyrus-edge-worker";
import {
	GitService,
	PromptBuilder,
	ToolPermissionResolver,
} from "cyrus-edge-worker";
import { BaseCommand } from "./ICommand.js";

/**
 * `cyrus personas [labels]` — answer "which persona would this issue get, and
 * what tools would it have?" against the **live** `config.json`.
 *
 * ## Why this exists
 *
 * Until now the only way to answer that question was to read
 * `PromptBuilder.matchSystemPromptForRepo` and simulate it by hand. That is how
 * the `safe`/`all` discrepancy survived four days: `docs/PERSONAS.md` said
 * `wayfinder-task` should be configured `safe`, the deployed config said `all`,
 * and nothing compared the two. `safe` withholds `Bash`, so the doc's version
 * would have left a persona unable to run tests, `git`, or `gh` (CYR-21).
 *
 * The point is that it reads the **deployed** config. A dry-run against a
 * hard-coded fixture would have agreed with the docs and missed the drift.
 *
 * ## Why it reuses the real resolvers
 *
 * It calls `PromptBuilder.determineSystemPromptFromLabels` and
 * `ToolPermissionResolver` rather than reimplementing the match. A
 * reimplementation would be a second copy of the rules, free to drift from the
 * ones that actually run — which is the exact failure mode this command exists
 * to detect.
 */
export class PersonasCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const { labels, repoFilter, json } = parseArgs(args);

		const config = this.app.config.load();
		const repositories = config.repositories ?? [];

		if (repositories.length === 0) {
			this.exitWithError(
				`No repositories configured in ${this.app.config.getConfigPath()}`,
			);
		}

		const selected = repoFilter
			? repositories.filter((r) => r.id === repoFilter || r.name === repoFilter)
			: repositories;

		if (selected.length === 0) {
			this.exitWithError(
				`No repository matched '${repoFilter}'. Configured: ${repositories
					.map((r) => r.id)
					.join(", ")}`,
			);
		}

		// A label set of `[]` means "an issue with no labels", which is a real
		// and interesting case — it is the fallback rung. So the absence of a
		// CLI argument is signalled by `labels === undefined`, never by `[]`.
		const scenarios = labels ? [labels] : deriveScenarios(selected);

		// Built once, outside the loop. These were constructed per
		// (repository, label set) pair, with `gitService: undefined as never` —
		// a cast that silences the type system on exactly the seam this command
		// promises to keep honest, and that breaks the moment
		// `determineSystemPromptFromLabels` touches a dependency. A real
		// `GitService` costs nothing here: its only uses on the prompt path are
		// `sanitizeBranchName` and `branchExists`, both of which work.
		const resolvers: Resolvers = {
			promptBuilder: new PromptBuilder({
				logger: SILENT_LOGGER,
				repositories: new Map(selected.map((r) => [r.id, r])),
				issueTrackers: new Map(),
				gitService: new GitService(
					// `config.json` lives at `<cyrusHome>/config.json`.
					{ cyrusHome: dirname(this.app.config.getConfigPath()) },
					SILENT_LOGGER,
				),
			}),
			toolResolver: new ToolPermissionResolver(
				this.app.config.load() as unknown as EdgeWorkerConfig,
				SILENT_LOGGER,
			),
		};

		const results: PersonaResult[] = [];
		for (const repository of selected) {
			for (const labelSet of scenarios) {
				results.push(await this.resolve(resolvers, repository, labelSet));
			}
		}

		if (json) {
			// `console.log` rather than the logger: `--json` output is meant to be
			// piped, and the logger decorates.
			console.log(JSON.stringify({ results }, null, 2));
			return;
		}

		this.report(results, this.app.config.getConfigPath());
	}

	private async resolve(
		{ promptBuilder, toolResolver }: Resolvers,
		repository: RepositoryConfig,
		labels: string[],
	): Promise<PersonaResult> {
		const match = await promptBuilder.determineSystemPromptFromLabels(labels, [
			repository,
		]);
		const promptType = match?.type;

		const allowed = toolResolver.buildAllowedTools(repository, promptType);
		const disallowed = toolResolver.buildDisallowedTools(
			repository,
			promptType,
		);

		// `allowedTools` is only an auto-approve list. What the session can
		// actually *see* is `deriveBuiltInTools(allowed)`, and what it is refused
		// is `disallowed` plus `deriveBuiltInDisallowedTools(allowed)`. Reporting
		// the pre-derivation lists made this command disagree with the runtime it
		// exists to check: a persona configured `Edit(src/**)` was reported as
		// having `Edit`, while the derivation withholds `Edit` entirely because an
		// argument-narrowed grant on a mutating tool is unenforceable. A drift
		// detector that has drifted is worse than none, because it gets trusted.
		const dropped: Array<{ entry: string; reason: string }> = [];
		const effectiveTools =
			deriveBuiltInTools(allowed, {
				onDropped: (entry, reason) => dropped.push({ entry, reason }),
			}) ?? [];
		const effectiveDisallowed = [
			...new Set([...disallowed, ...deriveBuiltInDisallowedTools(allowed)]),
		];

		return {
			repository: repository.id,
			labels,
			persona: promptType ?? null,
			promptFile: promptType
				? `packages/edge-worker/prompts/${promptType}.md`
				: null,
			// `match` exists but carries no version → the prompt file shipped
			// without a `<version-tag>`, so its sessions log no
			// `systemPromptVersion`. That is the `scoper.md` defect.
			version: match ? (match.version ?? null) : null,
			missingVersionTag: Boolean(match && !match.version),
			allowedCount: allowed.length,
			allowed,
			disallowed,
			effectiveTools,
			effectiveDisallowed,
			dropped,
			// Derived from `effectiveTools`, which carries bare names. Comparing
			// against `allowed` needed the argument stripped — `availableTools`
			// ships `Edit(**)` and `Write(**)`, not the bare names, so exact
			// equality reported `canWrite: false` for a repository configured
			// `["Read(**)","Edit(**)","Write(**)","Bash"]` and the `safe`-preset
			// warning never fired. (`MultiEdit` was also in that comparison and is
			// not in `availableTools` at all.)
			canWrite: effectiveTools.some((t) =>
				["Write", "Edit", "NotebookEdit"].includes(t),
			),
			shell: classifyShell(allowed, effectiveTools),
		};
	}

	private report(results: PersonaResult[], configPath: string): void {
		this.logger.info(`Config: ${configPath}`);
		this.logger.info("");

		let currentRepo: string | undefined;
		for (const r of results) {
			if (r.repository !== currentRepo) {
				currentRepo = r.repository;
				this.logDivider();
				this.logger.info(`Repository: ${r.repository}`);
				this.logDivider();
			}

			const labelText = r.labels.length ? r.labels.join(", ") : "(no labels)";
			this.logger.info("");
			this.logger.info(`  labels:   ${labelText}`);
			this.logger.info(
				`  persona:  ${r.persona ?? "(none) — falls back to the default issue prompt"}`,
			);
			if (r.promptFile) {
				this.logger.info(`  prompt:   ${r.promptFile}`);
				this.logger.info(`  version:  ${r.version ?? "(none)"}`);
			}
			this.logger.info(
				`  write:    ${r.canWrite ? "YES — Write/Edit present" : "no"}`,
			);
			this.logger.info(`  shell:    ${SHELL_LABEL[r.shell]}`);
			// Both numbers, because they differ and the difference is the point:
			// the first is what the config says, the second is what the session
			// gets after `deriveBuiltInTools` / `deriveBuiltInDisallowedTools`.
			this.logger.info(
				`  tools:    ${r.allowedCount} allowed (auto-approve), ${r.disallowed.length} denied in config`,
			);
			this.logger.info(
				`  effective: ${r.effectiveTools.length} built-in tools visible, ${r.effectiveDisallowed.length} denied`,
			);
			for (const { entry, reason } of r.dropped) {
				this.logger.warn(`  ⚠ dropped ${entry}: ${reason}`);
			}

			for (const warning of warningsFor(r)) {
				this.logger.warn(`  ⚠ ${warning}`);
			}
		}

		this.logger.info("");
		const flagged = results.filter((r) => warningsFor(r).length > 0);
		if (flagged.length === 0) {
			this.logger.success("No problems found.");
			return;
		}
		this.logger.warn(
			`${flagged.length} of ${results.length} combinations have warnings (see ⚠ above).`,
		);
	}
}

/** The real resolvers this command dry-runs against, constructed once. */
interface Resolvers {
	promptBuilder: PromptBuilder;
	toolResolver: ToolPermissionResolver;
}

type ShellAccess = "full" | "narrowed" | "none";

const SHELL_LABEL: Record<ShellAccess, string> = {
	full: "full Bash",
	narrowed: "narrowed Bash(...) grants only",
	none: "NO Bash at all",
};

export interface PersonaResult {
	repository: string;
	labels: string[];
	persona: PromptType | null;
	promptFile: string | null;
	version: string | null;
	missingVersionTag: boolean;
	allowedCount: number;
	/** The configured allow-list — an auto-approve list, not a capability set. */
	allowed: string[];
	/** The configured deny-list, before the derived rules are added. */
	disallowed: string[];
	/** `deriveBuiltInTools(allowed)` — the built-ins the session can see. */
	effectiveTools: string[];
	/** `disallowed` + `deriveBuiltInDisallowedTools(allowed)` — the real deny set. */
	effectiveDisallowed: string[];
	/** Entries the derivation withheld, with the reason it gives operators. */
	dropped: Array<{ entry: string; reason: string }>;
	canWrite: boolean;
	shell: ShellAccess;
}

/**
 * The two warnings this command exists to raise.
 *
 * Both are real defects that shipped and were found by hand rather than by a
 * tool: a persona with write access but no shell (CYR-21, from the `safe`
 * preset) and a prompt file with no version tag (`scoper.md`, which logged no
 * `systemPromptVersion` for several releases).
 */
export function warningsFor(r: PersonaResult): string[] {
	const warnings: string[] = [];

	if (r.canWrite && r.shell === "none") {
		warnings.push(
			"Can edit files but has NO shell — cannot run tests, lint, git, or gh. " +
				"This is the `safe` preset trap (CYR-21); `all` is almost certainly meant.",
		);
	} else if (r.shell === "none" && r.persona) {
		warnings.push(
			"No shell at all. Read-only personas normally want narrowed Bash(git ...) grants " +
				"so they can inspect history.",
		);
	}

	if (r.missingVersionTag) {
		warnings.push(
			`${r.promptFile} has no <version-tag>, so its sessions log no systemPromptVersion.`,
		);
	}

	// A grant the config makes and the derivation withholds. Operators read
	// `allowedTools` as a capability list, so a silent drop is exactly the drift
	// this command exists to surface — one layer below where it used to look.
	for (const { entry, reason } of r.dropped) {
		warnings.push(`\`${entry}\` is configured but not granted: ${reason}`);
	}

	return warnings;
}

/**
 * Build the default matrix: every label mentioned anywhere in the selected
 * repositories' `labelPrompts`, each on its own, plus the no-label case.
 *
 * Deriving the scenarios from the config rather than hard-coding them is what
 * keeps this useful as personas are added — a new `labelPrompts` key shows up
 * in the matrix without anyone editing this file.
 */
export function deriveScenarios(repositories: RepositoryConfig[]): string[][] {
	const labels = new Set<string>();

	for (const repository of repositories) {
		for (const value of Object.values(repository.labelPrompts ?? {})) {
			const configured = Array.isArray(value) ? value : (value?.labels ?? []);
			for (const label of configured) {
				labels.add(label);
			}
		}
	}

	// `[]` last: it reads as the summary case — "and what does an unlabelled
	// issue get?" — after the configured labels.
	return [...[...labels].sort().map((l) => [l]), []];
}

/**
 * How much shell a session really gets.
 *
 * `effectiveTools` decides whether there is a shell at all — a `Bash(...)` entry
 * in `allowedTools` only means something if the derivation kept `Bash`. Given
 * that it did, `allowed` decides whether the shell is narrowed, because that is
 * where the scope lives; `effectiveTools` carries the bare name either way.
 */
export function classifyShell(
	allowed: string[],
	effectiveTools?: string[],
): ShellAccess {
	if (effectiveTools && !effectiveTools.includes("Bash")) return "none";
	if (allowed.includes("Bash")) return "full";
	if (allowed.some((t) => t.startsWith("Bash("))) {
		// `Bash(*)` / `Bash(**)` impose no real scope.
		const scoped = allowed
			.filter((t) => t.startsWith("Bash("))
			.some((t) => !/^Bash\(\*+\)$/.test(t.trim()));
		return scoped ? "narrowed" : "full";
	}
	return effectiveTools?.includes("Bash") ? "full" : "none";
}

export function parseArgs(args: string[]): {
	labels: string[] | undefined;
	repoFilter: string | undefined;
	json: boolean;
} {
	let labels: string[] | undefined;
	let repoFilter: string | undefined;
	let json = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--json") {
			json = true;
		} else if (arg === "--repo") {
			repoFilter = args[++i];
		} else if (arg.startsWith("--repo=")) {
			repoFilter = arg.slice("--repo=".length);
		} else if (!arg.startsWith("-")) {
			// A positional label list. `"a, b"` and `"a,b"` both work; empty
			// segments are dropped so a trailing comma is harmless.
			labels = arg
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}

	return { labels, repoFilter, json };
}

/**
 * The resolvers log at debug level on every call. This command's output *is*
 * the report, so their narration is suppressed rather than interleaved.
 */
const SILENT_LOGGER: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	event: () => {},
	withContext: () => SILENT_LOGGER,
	getLevel: () => LogLevel.SILENT,
	setLevel: () => {},
};
