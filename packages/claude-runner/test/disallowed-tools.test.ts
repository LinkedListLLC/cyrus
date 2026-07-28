import * as claudeCode from "@anthropic-ai/claude-agent-sdk";
import { createLogger, LogLevel } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

// Mock the query function from @anthropic-ai/claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system with all required methods
vi.mock("fs", () => ({
	readFileSync: vi.fn(() => "{}"),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
	statSync: vi.fn(() => ({
		isDirectory: vi.fn(() => true),
	})),
}));

describe("ClaudeRunner - disallowedTools", () => {
	const queryMock = vi.mocked(claudeCode.query);

	beforeEach(() => {
		vi.clearAllMocks();

		// Mock the query to return an async generator
		queryMock.mockImplementation(async function* () {
			// Empty generator for testing
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should pass disallowedTools to Claude Code when configured", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read", "Edit"],
			disallowedTools: ["Bash", "WebFetch"],
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			// Yield a session ID message
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);

		// Run the query with a test prompt
		const prompt = "Test prompt";
		const _messages = [];

		await runner.start(prompt);

		// Check that query was called with disallowedTools
		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		// Configured denials are passed through. Since CYR-25 they are merged
		// with the list derived from `allowedTools` rather than replacing it, so
		// this asserts containment instead of equality.
		expect(callArgs.options.disallowedTools).toContain("Bash");
		expect(callArgs.options.disallowedTools).toContain("WebFetch");
		expect(callArgs.options.allowedTools).toContain("Read");
		expect(callArgs.options.allowedTools).toContain("Edit");
	});

	// Changed by CYR-25. This used to assert that a restricted session got no
	// `disallowedTools` at all — which was the bug: the deny layer, the only one
	// that survives the SDK's sandbox auto-allow and settings-file shadowing,
	// was never populated. A restricted allow-list now derives its own denials.
	it("derives disallowedTools for a restricted session even when none are configured", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read", "Edit"],
			// No disallowedTools
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test prompt");

		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		// `Edit` was granted, so it must NOT be denied — deny beats allow, and
		// denying it would silently revoke the grant.
		expect(callArgs.options.disallowedTools).not.toContain("Edit");
		expect(callArgs.options.disallowedTools).toContain("Write");
		expect(callArgs.options.disallowedTools).toContain("Bash(sed:*)");
		expect(callArgs.options.allowedTools).toContain("Read");
		expect(callArgs.options.allowedTools).toContain("Edit");
	});

	it("leaves an unrestricted builder with no derived denials", async () => {
		// A bare `Bash` grant means unrestricted by intent. Clamping these
		// personas would break committing, pushing and opening PRs.
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read", "Write", "Edit", "Bash"],
			cyrusHome: "/test/cyrus",
		};

		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: { session_id: "test-session" },
			};
		});

		await new ClaudeRunner(config).start("Test prompt");

		const callArgs = queryMock.mock.calls[0][0];
		expect(callArgs.options.disallowedTools).toBeUndefined();
	});

	it("should handle empty disallowedTools array", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read", "Edit"],
			disallowedTools: [], // Empty array
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test prompt");

		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		// An explicitly empty config array adds nothing, but it must not
		// suppress the derived list — that is the `[]`-is-truthy trap CYR-28
		// fixed on the allowed side.
		expect(callArgs.options.disallowedTools).toContain("Write");
	});

	it("should log disallowedTools when configured", async () => {
		const consoleSpy = vi.spyOn(console, "log");

		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			disallowedTools: ["Bash", "SystemAccess", "DangerousTool"],
			cyrusHome: "/test/cyrus",
			logger: createLogger({
				component: "ClaudeRunner",
				level: LogLevel.DEBUG,
			}),
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test");

		// Check that disallowedTools were logged (now at DEBUG level via logger)
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[DEBUG] \[ClaudeRunner] Disallowed tools configured:$/,
			),
			["Bash", "SystemAccess", "DangerousTool"],
		);

		consoleSpy.mockRestore();
	});
});
