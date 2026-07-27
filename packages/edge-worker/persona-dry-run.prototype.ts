/**
 * PROTOTYPE — throwaway. Not wired into anything, no tests, no error handling.
 * Answers CYR-41: "which persona would this issue get?" as a dry-run.
 *
 * Give it a repo (baked in below) and some labels; it reuses the REAL
 * PromptBuilder + ToolPermissionResolver — no re-implementation of the match —
 * and prints the persona, the prompt file + version, and the resolved tool list.
 *
 * Run it:
 *   cd packages/edge-worker
 *   npx tsx persona-dry-run.prototype.ts                       # built-in matrix
 *   npx tsx persona-dry-run.prototype.ts "wayfinder:prototype" # one label set
 *   npx tsx persona-dry-run.prototype.ts "Bug,wayfinder:research"
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { PromptBuilder } from "./src/PromptBuilder.js";
import { ToolPermissionResolver } from "./src/ToolPermissionResolver.js";

// --- fakes: only what the two classes actually touch on this path ----------
const silent: ILogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	event() {},
	withContext() {
		return silent;
	},
	getLevel() {
		return 4;
	},
	setLevel() {},
};

// The DEPLOYED shape (docs/PERSONAS.md, verified 2026-07-27): all three repos
// carry exactly these two Wayfinder keys and nothing else. Edit this to model a
// different repo. `scoper`/`builder`/`debugger`/`orchestrator` are unrouted
// today — a `Bug`-only issue matches nothing and falls back to the default
// issue prompt, which is itself a useful thing to see.
const REPO = {
	id: "cyrus",
	name: "cyrus",
	labelPrompts: {
		wayfinder: {
			labels: ["wayfinder:map", "wayfinder:research", "wayfinder:grilling"],
			allowedTools: "readOnly",
		},
		"wayfinder-task": {
			labels: ["wayfinder:task", "wayfinder:prototype"],
			allowedTools: "all",
		},
	},
} as unknown as RepositoryConfig;

const promptBuilder = new PromptBuilder({
	logger: silent,
	repositories: new Map(),
	issueTrackers: new Map(),
	gitService: {} as never,
});
// Empty config → ToolPermissionResolver falls through to LINEAR_DEFAULT when a
// persona sets no preset. The two Wayfinder keys DO set a preset, so rung 1 wins.
const tools = new ToolPermissionResolver({} as EdgeWorkerConfig, silent);

const __dirname_ = dirname(fileURLToPath(import.meta.url));

async function dryRun(labels: string[]): Promise<void> {
	console.log(`\n${"=".repeat(70)}`);
	console.log(`labels: ${labels.length ? labels.join(", ") : "(none)"}`);

	const match = await promptBuilder.determineSystemPromptFromLabels(labels, [
		REPO,
	]);

	if (!match) {
		console.log(
			"persona:   (none) — no label matched; falls back to the default",
		);
		console.log(
			"           issue-assigned prompt with the workspace tool set.",
		);
		const allowed = tools.buildAllowedTools(REPO); // no promptType
		printTools(allowed, tools.buildDisallowedTools(REPO));
		return;
	}

	const type = match.type!;
	const promptFile = join(__dirname_, "prompts", `${type}.md`);
	const allowed = tools.buildAllowedTools(REPO, type);
	const disallowed = tools.buildDisallowedTools(REPO, type);

	console.log(`persona:   ${type}`);
	console.log(`prompt:    packages/edge-worker/prompts/${type}.md`);
	console.log(`version:   ${match.version ?? "(no <version-tag>!)"}`);
	console.log(`file:      ${promptFile}`);
	printTools(allowed, disallowed);
}

function printTools(allowed: string[], disallowed: string[]): void {
	const hasBareBash = allowed.includes("Bash");
	const hasNarrowedBash = allowed.some((t) => t.startsWith("Bash("));
	const canWrite = allowed.some((t) =>
		["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(t),
	);
	console.log(`allowed:   ${allowed.length} tools`);
	console.log(
		`  write access:  ${canWrite ? "YES (Write/Edit present)" : "no"}`,
	);
	console.log(
		`  shell:         ${
			hasBareBash
				? "full Bash"
				: hasNarrowedBash
					? "narrowed Bash(...) only"
					: "NO Bash at all  ← cannot run tests/lint/git/gh"
		}`,
	);
	console.log(`  list:          ${allowed.join(", ")}`);
	console.log(
		`disallowed: ${disallowed.length ? disallowed.join(", ") : "(none)"}`,
	);
}

const arg = process.argv[2];
const scenarios: string[][] = arg
	? [arg.split(",").map((s) => s.trim())]
	: [
			["wayfinder:prototype"],
			["wayfinder:task"],
			["wayfinder:map"],
			["wayfinder:research"],
			["wayfinder:grilling"],
			["Bug", "wayfinder:research"], // the ordering guarantee: wayfinder wins
			["Bug"], // unrouted today → default prompt
			["orchestrator"], // hardcoded rule, even with no labelPrompts entry
		];

for (const labels of scenarios) {
	await dryRun(labels);
}
console.log();
