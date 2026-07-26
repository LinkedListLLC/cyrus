import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { PromptType } from "../src/ToolPermissionResolver.js";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

/**
 * CYR-25 — the *disallowed* side of the five-rung ladder.
 *
 * `buildDisallowedToolsForRepo` has the same shape as the allowed side, and it
 * had the same latent hazard: `[]` is truthy in JavaScript, so a
 * configured-but-empty list at any rung short-circuited the ladder and made
 * every rung below it unreachable. On the allowed side that bug (CYR-28) lived
 * for two months and silently disabled the platform-default fallback.
 *
 * An empty deny list is a safer default than an empty *allow* list was, so the
 * consequences here are milder — but the trap is identical, and these tests
 * exist so it cannot be reintroduced.
 */

const noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

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

function makeEdgeWorkerConfig(
	overrides: Partial<EdgeWorkerConfig> = {},
): EdgeWorkerConfig {
	return {
		version: "0.2.66",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [makeRepository()],
		defaultDisallowedTools: undefined,
		handlers: {},
		...overrides,
	} as EdgeWorkerConfig;
}

function resolve(
	config: EdgeWorkerConfig,
	repository: RepositoryConfig,
	promptType?: PromptType,
): string[] {
	return new ToolPermissionResolver(config, noopLogger).buildDisallowedTools(
		repository,
		promptType,
	);
}

describe("ToolPermissionResolver — disallowedTools ladder (CYR-25)", () => {
	// The core CYR-28-shaped assertion: an empty array at a higher rung must
	// behave as "nothing configured here", not as "stop, the answer is nothing".
	describe("an empty array does not short-circuit the ladder", () => {
		it("falls through an empty repo-level list to the global default", () => {
			const denied = resolve(
				makeEdgeWorkerConfig({ defaultDisallowedTools: ["Write"] }),
				makeRepository({ disallowedTools: [] }),
			);

			expect(denied).toEqual(["Write"]);
		});

		for (const promptType of PROMPT_TYPES) {
			const label = promptType ?? "(no label)";

			it(`falls through an empty prompt-type list to the global default for "${label}"`, () => {
				const denied = resolve(
					makeEdgeWorkerConfig({
						defaultDisallowedTools: ["Write"],
						...(promptType && {
							promptDefaults: { [promptType]: { disallowedTools: [] } },
						}),
					}),
					makeRepository(),
					promptType,
				);

				expect(denied).toEqual(["Write"]);
			});
		}

		it("falls through an empty per-repo prompt list to the global default", () => {
			const denied = resolve(
				makeEdgeWorkerConfig({ defaultDisallowedTools: ["Write"] }),
				makeRepository({
					labelPrompts: {
						builder: { labels: ["builder"], disallowedTools: [] },
					},
				} as Partial<RepositoryConfig>),
				"builder",
			);

			expect(denied).toEqual(["Write"]);
		});

		it("resolves identically whether a rung is [] or absent", () => {
			const withEmpty = resolve(
				makeEdgeWorkerConfig({ defaultDisallowedTools: ["Write"] }),
				makeRepository({ disallowedTools: [] }),
			);
			const withAbsent = resolve(
				makeEdgeWorkerConfig({ defaultDisallowedTools: ["Write"] }),
				makeRepository({ disallowedTools: undefined }),
			);

			expect(withEmpty).toEqual(withAbsent);
		});
	});

	describe("priority order is preserved", () => {
		it("prefers a non-empty repo-level list over the global default", () => {
			const denied = resolve(
				makeEdgeWorkerConfig({ defaultDisallowedTools: ["Write"] }),
				makeRepository({ disallowedTools: ["Edit"] }),
			);

			expect(denied).toEqual(["Edit"]);
		});

		it("prefers a non-empty prompt-type default over the repo-level list", () => {
			const denied = resolve(
				makeEdgeWorkerConfig({
					defaultDisallowedTools: ["Write"],
					promptDefaults: { builder: { disallowedTools: ["NotebookEdit"] } },
				} as Partial<EdgeWorkerConfig>),
				makeRepository({ disallowedTools: ["Edit"] }),
				"builder",
			);

			expect(denied).toEqual(["NotebookEdit"]);
		});

		it("returns [] when nothing is configured anywhere", () => {
			// Rung 5 is deliberately empty: the deny list a restricted persona
			// needs is derived from its own allowedTools in claude-runner, not
			// pinned to a fixed list here. A static default could not tell a
			// read-only reviewer from an unrestricted builder.
			expect(resolve(makeEdgeWorkerConfig(), makeRepository())).toEqual([]);
		});
	});
});
