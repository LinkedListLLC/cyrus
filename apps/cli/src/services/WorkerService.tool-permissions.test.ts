import { deriveBuiltInTools } from "cyrus-claude-runner";
import type {
	EdgeConfig,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { LINEAR_DEFAULT_ALLOWED_TOOLS } from "cyrus-core";
import type { PromptType } from "cyrus-edge-worker";
import { ToolPermissionResolver } from "cyrus-edge-worker";
import { describe, expect, it } from "vitest";
import {
	parseToolListEnv,
	resolveToolPermissionConfig,
} from "./WorkerService.js";

/**
 * Regression coverage for CYR-28, from the CLI end of the wire.
 *
 * The bug had two halves in two packages, and either half alone leaves the
 * trap set for the next caller:
 *
 *   1. The CLI defaulted `linearAllowedTools` to `[]` when nothing was
 *      configured, instead of `undefined`.
 *   2. `ToolPermissionResolver` guarded its workspace-default rung on plain
 *      truthiness, and `[]` is truthy — so it returned the empty list and the
 *      platform-default rung below it became unreachable.
 *
 * The result was sessions with an empty allow-list, and therefore (since the
 * SDK `tools` option derives from `allowedTools`) no tools at all.
 *
 * These tests feed the config the CLI *actually* builds into the real
 * resolver, rather than asserting against a hand-written literal.
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

/** An `edgeConfig` with nothing tool-related configured — the common case. */
const emptyEdgeConfig = { repositories: [] } as unknown as EdgeConfig;

/** Assemble the tool-relevant slice of the config exactly as the CLI does. */
function buildCliConfig(
	edgeConfig: EdgeConfig = emptyEdgeConfig,
	env: NodeJS.ProcessEnv = {},
	repositories: RepositoryConfig[] = [makeRepository()],
): EdgeWorkerConfig {
	return {
		version: "0.2.66",
		cyrusHome: "/tmp/cyrus-home",
		repositories,
		...resolveToolPermissionConfig(edgeConfig, env),
		handlers: {},
	} as EdgeWorkerConfig;
}

describe("resolveToolPermissionConfig", () => {
	it("leaves linearAllowedTools undefined when nothing is configured", () => {
		const config = resolveToolPermissionConfig(emptyEdgeConfig, {});

		// The core of the bug: this used to be `[]`.
		expect(config.linearAllowedTools).toBeUndefined();
	});

	it("matches the undefined default already used by defaultDisallowedTools", () => {
		const config = resolveToolPermissionConfig(emptyEdgeConfig, {});

		expect(config.defaultDisallowedTools).toBeUndefined();
		expect(config.linearAllowedTools).toBeUndefined();
	});

	it("prefers the environment variable over the config file", () => {
		const config = resolveToolPermissionConfig(
			{ linearAllowedTools: ["Read"] } as unknown as EdgeConfig,
			{ LINEAR_ALLOWED_TOOLS: "Bash, Write ,Edit" },
		);

		expect(config.linearAllowedTools).toEqual(["Bash", "Write", "Edit"]);
	});

	it("falls through to the config file when the environment variable is absent", () => {
		const config = resolveToolPermissionConfig(
			{ linearAllowedTools: ["Read", "Grep"] } as unknown as EdgeConfig,
			{},
		);

		expect(config.linearAllowedTools).toEqual(["Read", "Grep"]);
	});

	it("treats a blank environment variable as unset rather than one empty tool", () => {
		// `"".split(",")` is `[""]` — truthy, and a bogus one-entry allow-list.
		expect(
			resolveToolPermissionConfig(emptyEdgeConfig, {
				LINEAR_ALLOWED_TOOLS: "",
			}).linearAllowedTools,
		).toBeUndefined();

		expect(
			resolveToolPermissionConfig(emptyEdgeConfig, {
				LINEAR_ALLOWED_TOOLS: " , ,",
			}).linearAllowedTools,
		).toBeUndefined();
	});

	it("applies the same env parsing to DISALLOWED_TOOLS", () => {
		expect(
			resolveToolPermissionConfig(emptyEdgeConfig, {
				DISALLOWED_TOOLS: "Bash , WebFetch",
			}).defaultDisallowedTools,
		).toEqual(["Bash", "WebFetch"]);

		expect(
			resolveToolPermissionConfig(emptyEdgeConfig, {
				DISALLOWED_TOOLS: "",
			}).defaultDisallowedTools,
		).toBeUndefined();
	});

	it("holds the never-[] invariant for the fields the env cannot set", () => {
		// The docblock promises this of *every* field. Only the two env-backed
		// ones went through a normaliser, so a `"slackAllowedTools": []` in
		// config.json reached the resolver as the very shape the ladder
		// misreads — the invariant was stated but not held.
		const config = resolveToolPermissionConfig(
			{
				linearAllowedTools: [],
				slackAllowedTools: [],
				githubAllowedTools: [],
				defaultDisallowedTools: [],
			} as unknown as EdgeConfig,
			{},
		);

		expect(config.linearAllowedTools).toBeUndefined();
		expect(config.slackAllowedTools).toBeUndefined();
		expect(config.githubAllowedTools).toBeUndefined();
		expect(config.defaultDisallowedTools).toBeUndefined();
	});

	it("drops blank entries from a config-file list", () => {
		const config = resolveToolPermissionConfig(
			{
				slackAllowedTools: [" Read ", "", "  "],
			} as unknown as EdgeConfig,
			{},
		);

		expect(config.slackAllowedTools).toEqual(["Read"]);
	});
});

describe("parseToolListEnv", () => {
	it("returns undefined for unset, empty and blank-only values", () => {
		expect(parseToolListEnv(undefined)).toBeUndefined();
		expect(parseToolListEnv("")).toBeUndefined();
		expect(parseToolListEnv("   ")).toBeUndefined();
		expect(parseToolListEnv(",,")).toBeUndefined();
	});

	it("trims entries and drops blanks", () => {
		expect(parseToolListEnv(" Read , ,Bash ")).toEqual(["Read", "Bash"]);
	});
});

describe("CLI config -> ToolPermissionResolver (end to end)", () => {
	for (const promptType of PROMPT_TYPES) {
		const label = promptType ?? "(no label)";

		it(`gives "${label}" sessions a non-empty tool set`, () => {
			const config = buildCliConfig();
			const resolver = new ToolPermissionResolver(config, noopLogger);
			const allowed = resolver.buildAllowedTools(makeRepository(), promptType);
			const tools = deriveBuiltInTools(allowed) ?? [];

			// Before the fix every one of these was `allowed=0 tools=0`.
			expect(allowed).toEqual([...LINEAR_DEFAULT_ALLOWED_TOOLS]);
			expect(allowed).toHaveLength(33);
			expect(tools).toHaveLength(31);
			expect(tools).toContain("Bash");
			expect(tools).toContain("Read");
			expect(tools).toContain("Write");
			expect(tools).toContain("Edit");
		});
	}

	it("keeps honouring an explicitly narrowed workspace list", () => {
		const config = buildCliConfig(emptyEdgeConfig, {
			LINEAR_ALLOWED_TOOLS: "Read,Grep",
		});
		const resolver = new ToolPermissionResolver(config, noopLogger);

		expect(resolver.buildAllowedTools(makeRepository())).toEqual([
			"Read",
			"Grep",
		]);
	});

	it("keeps honouring the repo-level stop-gap array", () => {
		const stopGap = [...LINEAR_DEFAULT_ALLOWED_TOOLS];
		const config = buildCliConfig();
		const resolver = new ToolPermissionResolver(config, noopLogger);

		expect(
			resolver.buildAllowedTools(makeRepository({ allowedTools: stopGap })),
		).toEqual(stopGap);
	});
});
