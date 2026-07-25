import * as claudeCode from "@anthropic-ai/claude-agent-sdk";
import { SLACK_DEFAULT_ALLOWED_TOOLS } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deriveBuiltInTools,
	KNOWN_BUILT_IN_TOOLS,
} from "../src/built-in-tool-restrictions";
import { ClaudeRunner } from "../src/ClaudeRunner";
import { readOnlyTools } from "../src/config";
import type { ClaudeRunnerConfig } from "../src/types";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("fs", () => ({
	readFileSync: vi.fn(() => "{}"),
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
	statSync: vi.fn(() => ({ isDirectory: vi.fn(() => true) })),
}));

/** Built-in tools that let a session modify the repository. */
const MUTATING = ["Write", "Edit", "Bash", "NotebookEdit"];

describe("deriveBuiltInTools", () => {
	it("returns undefined when no allowedTools list is configured, leaving the SDK default in place", () => {
		expect(deriveBuiltInTools(undefined)).toBeUndefined();
	});

	it("grants bare built-in names verbatim", () => {
		expect(deriveBuiltInTools(["WebFetch", "WebSearch", "Task"])).toEqual([
			"Task",
			"WebFetch",
			"WebSearch",
		]);
	});

	it("strips wildcard argument suffixes used by the tool catalog", () => {
		expect(deriveBuiltInTools(["Read(**)", "Write(**)", "Edit(**)"])).toEqual([
			"Edit",
			"Glob",
			"Grep",
			"Read",
			"Write",
		]);
	});

	// Fail-closed rule 1.
	it("drops unrecognized tool names instead of forwarding them", () => {
		const dropped: string[] = [];
		const result = deriveBuiltInTools(["Read", "NotARealTool"], {
			onDropped: (entry) => dropped.push(entry),
		});

		expect(result).not.toContain("NotARealTool");
		expect(dropped).toEqual(["NotARealTool"]);
	});

	// Fail-closed rule 2 — the crux of CYR-15. `Bash(git -C * pull)` reads as a
	// narrow grant, but allowedTools patterns only auto-approve and never deny,
	// so granting Bash at all would hand a read-only persona an arbitrary shell.
	it("withholds a mutating tool that is only granted with a narrowing argument", () => {
		const dropped: Array<[string, string]> = [];
		const result = deriveBuiltInTools(["Read", "Bash(git -C * pull)"], {
			onDropped: (entry, reason) => dropped.push([entry, reason]),
		});

		expect(result).not.toContain("Bash");
		expect(dropped[0]?.[0]).toBe("Bash(git -C * pull)");
		expect(dropped[0]?.[1]).toMatch(/cannot be enforced/);
	});

	it("still grants a mutating tool when the grant is unrestricted", () => {
		expect(deriveBuiltInTools(["Bash"])).toContain("Bash");
		expect(deriveBuiltInTools(["Bash(*)"])).toContain("Bash");
	});

	// Read is not mutating, so path narrowing (which ClaudeRunner generates from
	// allowedDirectories) is safe to ignore rather than fail closed on.
	it("keeps Read when it is granted only with a path-scoped pattern", () => {
		const result = deriveBuiltInTools(["Read(//Users/alice/repo/**)"]);
		expect(result).toContain("Read");
	});

	it("grants the read-only search tools alongside Read", () => {
		const result = deriveBuiltInTools(["Read"]);
		expect(result).toEqual(["Glob", "Grep", "Read"]);
	});

	it("does not grant search tools when Read itself was not granted", () => {
		const result = deriveBuiltInTools(["WebSearch"]);
		expect(result).toEqual(["WebSearch"]);
	});

	// `tools` governs the built-in set only; mcp__* entries are silently ignored
	// by the SDK, so mapping them through would be misleading.
	it("ignores mcp__ entries rather than mapping them into the built-in set", () => {
		const result = deriveBuiltInTools([
			"Read",
			"mcp__linear",
			"mcp__cyrus-tools",
		]);
		expect(result?.some((tool) => tool.startsWith("mcp__"))).toBe(false);
	});

	it("opts AskUserQuestion back in when requested", () => {
		expect(
			deriveBuiltInTools(["Read"], { includeAskUserQuestion: true }),
		).toContain("AskUserQuestion");
		expect(deriveBuiltInTools(["Read"])).not.toContain("AskUserQuestion");
	});

	it("returns an empty set when nothing is granted, disabling all built-ins", () => {
		expect(deriveBuiltInTools([])).toEqual([]);
		expect(deriveBuiltInTools(["mcp__linear"])).toEqual([]);
	});

	it("recognizes every tool in the readOnly preset", () => {
		for (const entry of readOnlyTools) {
			const name = entry.replace(/\(.*\)$/, "");
			expect(
				KNOWN_BUILT_IN_TOOLS.has(name),
				`readOnly preset tool "${name}" is not in KNOWN_BUILT_IN_TOOLS`,
			).toBe(true);
		}
	});
});

describe("ClaudeRunner - readOnly sessions cannot write (CYR-15)", () => {
	const queryMock = vi.mocked(claudeCode.query);

	beforeEach(() => {
		vi.clearAllMocks();
		queryMock.mockImplementation(async function* () {});
	});

	async function captureQueryOptions(
		config: ClaudeRunnerConfig,
	): Promise<Record<string, any>> {
		await new ClaudeRunner(config).start("test prompt");
		expect(queryMock).toHaveBeenCalledTimes(1);
		return (queryMock.mock.calls[0]?.[0] as any).options;
	}

	// This is the regression test for CYR-15. Before the fix `tools` was never
	// set, so a readOnly session had the entire built-in toolset — including
	// Write — in the model's context, and could create files. Verified live
	// against the real SDK: with only `allowedTools` set, the model called Write
	// and the file was created; with `tools` set, Write was absent from context
	// and no file was created.
	it("does not give a readOnly session any tool that can modify the repository", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		expect(options.tools).toBeDefined();
		for (const tool of MUTATING) {
			expect(options.tools).not.toContain(tool);
		}
	});

	it("leaves a readOnly session able to read and search the repository", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		expect(options.tools).toContain("Read");
		expect(options.tools).toContain("Grep");
		expect(options.tools).toContain("Glob");
	});

	// A read-only reviewer that cannot report back to Linear is useless. `tools`
	// governs built-ins only, so MCP tools stay reachable — this asserts we do
	// not accidentally start filtering them.
	it("keeps mcp__linear reachable under readOnly", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		// Still auto-approved...
		expect(options.allowedTools).toContain("mcp__linear");
		// ...and never filtered out by the built-in restriction.
		expect(options.tools).not.toContain("mcp__linear");
		expect(options.disallowedTools ?? []).not.toContain("mcp__linear");
	});

	it("still gives a full engineering session its write tools", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: ["Read", "Edit", "Write", "Bash", "NotebookEdit"],
		});

		for (const tool of MUTATING) {
			expect(options.tools).toContain(tool);
		}
	});

	it("does not restrict built-ins when no allowedTools list is configured", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
		});

		expect(options.tools).toBeUndefined();
	});

	it("lets an explicit tools config win over the derived set", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: ["Read"],
			tools: ["Read", "Bash"],
		});

		expect(options.tools).toEqual(["Read", "Bash"]);
	});
});
