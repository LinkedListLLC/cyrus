import { deriveBuiltInTools, getAllTools } from "cyrus-claude-runner";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import {
	LINEAR_DEFAULT_ALLOWED_TOOLS,
	SLACK_DEFAULT_ALLOWED_TOOLS,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { PromptType } from "../src/ToolPermissionResolver.js";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

/**
 * Regression coverage for CYR-28: the platform-default `allowedTools` fallback
 * was unreachable, so ordinary sessions resolved to *zero* tools.
 *
 * `ToolPermissionResolver` walks a five-rung priority ladder and rung 4
 * (workspace `linearAllowedTools`) was an unguarded truthiness check. The CLI
 * built that field as `[]` when nothing was configured — and `[]` is truthy —
 * so rung 4 returned the empty list and rung 5 (the platform default) was dead
 * code. Because the SDK `tools` option derives from `allowedTools`, an empty
 * allow-list means the session gets no built-in tools at all.
 *
 * These tests deliberately exercise the ladder with **no** repo-level
 * `allowedTools`, because production config currently carries a repo-level
 * array as a stop-gap that short-circuits at rung 3 and hides the bug.
 */

const noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** The prompt types that flow through the Linear label-routing path. */
const PROMPT_TYPES: (PromptType | undefined)[] = [
	"builder",
	"scoper",
	"orchestrator",
	"debugger",
	undefined,
];

function makeRepository(
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id: "repo-1",
		name: "cyrus",
		repositoryPath: "/tmp/cyrus",
		baseBranch: "main",
		workspaceBaseDir: "/tmp/cyrus-workspaces",
		...overrides,
	} as RepositoryConfig;
}

/**
 * Build an `EdgeWorkerConfig` the way the CLI actually builds one.
 *
 * This mirrors `WorkerService.startEdgeWorker`, and it matters: the original
 * offline reproduction of this bug passed only because it omitted
 * `linearAllowedTools` entirely. A hand-written minimal literal does not
 * reproduce the defect — the empty array is the whole point.
 */
function makeEdgeWorkerConfig(
	overrides: Partial<EdgeWorkerConfig> = {},
): EdgeWorkerConfig {
	return {
		version: "0.2.66",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [makeRepository()],
		// What the CLI produced before the fix, when nothing was configured.
		linearAllowedTools: [],
		slackAllowedTools: undefined,
		githubAllowedTools: undefined,
		defaultDisallowedTools: undefined,
		handlers: {},
		...overrides,
	} as EdgeWorkerConfig;
}

function resolve(
	config: EdgeWorkerConfig,
	repository: RepositoryConfig,
	promptType?: PromptType,
): { allowed: string[]; tools: string[] } {
	const resolver = new ToolPermissionResolver(config, noopLogger);
	const allowed = resolver.buildAllowedTools(repository, promptType);
	return { allowed, tools: deriveBuiltInTools(allowed) ?? [] };
}

describe("ToolPermissionResolver — platform-default allowedTools fallback", () => {
	describe("with the config the CLI actually builds", () => {
		for (const promptType of PROMPT_TYPES) {
			const label = promptType ?? "(no label)";

			it(`resolves a non-empty tool set for "${label}" when linearAllowedTools is []`, () => {
				const { allowed, tools } = resolve(
					makeEdgeWorkerConfig({ linearAllowedTools: [] }),
					makeRepository(),
					promptType,
				);

				// The assertion that fails before the fix: every one of these
				// resolved to `allowed=0 tools=0`.
				expect(allowed.length).toBeGreaterThan(0);
				expect(tools.length).toBeGreaterThan(0);
				expect(allowed).toEqual([...LINEAR_DEFAULT_ALLOWED_TOOLS]);
			});

			it(`resolves identically for "${label}" whether linearAllowedTools is [] or absent`, () => {
				const withEmpty = resolve(
					makeEdgeWorkerConfig({ linearAllowedTools: [] }),
					makeRepository(),
					promptType,
				);
				const withAbsent = resolve(
					makeEdgeWorkerConfig({ linearAllowedTools: undefined }),
					makeRepository(),
					promptType,
				);

				expect(withEmpty.allowed).toEqual(withAbsent.allowed);
				expect(withEmpty.tools).toEqual(withAbsent.tools);
			});
		}

		it("pins the exact resolution for the default (unlabelled) session", () => {
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository(),
				undefined,
			);

			expect(allowed).toHaveLength(33);
			expect(tools).toHaveLength(31);
			expect(tools).toContain("Bash");
			expect(tools).toContain("Write");
			expect(tools).toContain("Edit");
		});

		it("still honours a workspace linearAllowedTools that is actually set", () => {
			const { allowed } = resolve(
				makeEdgeWorkerConfig({ linearAllowedTools: ["Read", "Grep"] }),
				makeRepository(),
				undefined,
			);

			expect(allowed).toEqual(["Read", "Grep"]);
		});

		it("falls back to the platform default when there are no repositories", () => {
			const resolver = new ToolPermissionResolver(
				makeEdgeWorkerConfig({ linearAllowedTools: [] }),
				noopLogger,
			);

			expect(resolver.buildAllowedTools([])).toEqual([
				...LINEAR_DEFAULT_ALLOWED_TOOLS,
			]);
		});
	});

	describe("rung 3 — repository-level allowedTools", () => {
		it("returns a repo-level array verbatim (the production stop-gap must keep working)", () => {
			const stopGap = [...LINEAR_DEFAULT_ALLOWED_TOOLS];
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository({ allowedTools: stopGap }),
				undefined,
			);

			expect(allowed).toEqual(stopGap);
			expect(allowed).toHaveLength(33);
			expect(tools).toHaveLength(31);
			expect(tools).toContain("Bash");
		});

		it("expands a repo-level preset string instead of treating it as one tool name", () => {
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				// Neither config loader validates against the Zod schema — both
				// `ConfigService.load` and `ConfigManager.loadConfigSafely` raw
				// `JSON.parse` and cast — so a preset string reaches the resolver
				// at runtime even though the type says `string[]`.
				makeRepository({ allowedTools: "all" as unknown as string[] }),
				undefined,
			);

			// Before the fix: allowed === ["all"], tools === [] — silently zero.
			expect(allowed).toEqual(getAllTools());
			expect(allowed).toHaveLength(29);
			expect(tools).toHaveLength(31);
			expect(tools).toContain("Bash");
			expect(tools).toContain("Write");
			expect(tools).toContain("Edit");
		});

		it("expands a repo-level readOnly preset string", () => {
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository({ allowedTools: "readOnly" as unknown as string[] }),
				undefined,
			);

			expect(allowed).toEqual([...SLACK_DEFAULT_ALLOWED_TOOLS]);
			expect(tools).toHaveLength(18);
			expect(tools).not.toContain("Write");
		});
	});

	describe("no regressions on the label-prompt rungs", () => {
		it('scoper with allowedTools "readOnly" resolves 20 -> 18, Bash present, Write/Edit absent', () => {
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository({
					labelPrompts: {
						scoper: { labels: ["Scoper"], allowedTools: "readOnly" },
					},
				}),
				"scoper",
			);

			expect(allowed).toHaveLength(20);
			expect(tools).toHaveLength(18);
			expect(tools).toContain("Bash");
			expect(tools).not.toContain("Write");
			expect(tools).not.toContain("Edit");
		});

		it('builder with allowedTools "all" resolves 29 -> 31 with Bash/Write/Edit', () => {
			const { allowed, tools } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository({
					labelPrompts: {
						builder: { labels: ["Builder"], allowedTools: "all" },
					},
				}),
				"builder",
			);

			expect(allowed).toHaveLength(29);
			expect(tools).toHaveLength(31);
			expect(tools).toContain("Bash");
			expect(tools).toContain("Write");
			expect(tools).toContain("Edit");
		});

		it("global promptDefaults still win over the workspace default", () => {
			const { allowed } = resolve(
				makeEdgeWorkerConfig({
					promptDefaults: {
						debugger: { allowedTools: ["Read", "Bash"] },
					},
				}),
				makeRepository(),
				"debugger",
			);

			expect(allowed).toEqual(["Read", "Bash"]);
		});

		it("graphite-orchestrator still aliases to the orchestrator config", () => {
			const { allowed } = resolve(
				makeEdgeWorkerConfig(),
				makeRepository({
					labelPrompts: {
						orchestrator: { labels: ["Orchestrator"], allowedTools: ["Task"] },
					},
				}),
				"graphite-orchestrator",
			);

			expect(allowed).toEqual(["Task"]);
		});
	});

	describe("sibling platform paths keep their existing behaviour", () => {
		it("chat sessions fall back to the Slack default when slackAllowedTools is []", () => {
			const resolver = new ToolPermissionResolver(
				makeEdgeWorkerConfig({ slackAllowedTools: [] }),
				noopLogger,
			);

			expect(resolver.buildChatAllowedTools()).toEqual([
				...SLACK_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("github sessions fall back to the GitHub default when linearAllowedTools is []", () => {
			const config = makeEdgeWorkerConfig({
				linearAllowedTools: [],
				githubAllowedTools: [],
			});
			const resolver = new ToolPermissionResolver(config, noopLogger);
			const allowed = resolver.buildGithubAllowedTools(makeRepository());

			expect(allowed.length).toBeGreaterThan(0);
			expect(deriveBuiltInTools(allowed) ?? []).not.toHaveLength(0);
			// The swap-and-restore around the Linear ladder must leave the
			// original workspace value untouched.
			expect(config.linearAllowedTools).toEqual([]);
		});
	});
});
