import * as claudeCode from "@anthropic-ai/claude-agent-sdk";
import {
	commandMatchesAllowedBash,
	MUTATING_BASH_DENY_RULES,
	REVIEW_ALLOWED_TOOLS,
	SLACK_DEFAULT_ALLOWED_TOOLS,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveBuiltInDisallowedTools } from "../src/built-in-tool-restrictions";
import { ClaudeRunner } from "../src/ClaudeRunner";
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

/**
 * CYR-25.
 *
 * `allowedTools` only auto-approves and `tools` only governs what is in the
 * model's context — neither can refuse a call. Two layers above them can wave a
 * command through before Cyrus is ever consulted:
 *
 *   1. Claude Code's **own read-only command classifier**, which pre-approves
 *      commands it considers non-mutating. Measured against the real SDK
 *      (0.3.205): a session whose only shell grant was `Bash(git -C * pull)`
 *      ran `git status` and `canUseTool` was never called. This is **not**
 *      `sandbox.autoAllowBashIfSandboxed` — it fires with no `sandbox` key
 *      configured at all (see `live-sdk-precedence.test.ts`), so it cannot be
 *      switched off from Cyrus.
 *   2. `permissions.allow` rules in a settings file, which the SDK warns can
 *      shadow `canUseTool` invisibly (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`).
 *
 * `disallowedTools` is evaluated ahead of both. These tests pin the deny list
 * Cyrus derives; `live-sdk-precedence.test.ts` exercises the precedence itself
 * against the real SDK.
 */
describe("deriveBuiltInDisallowedTools (CYR-25)", () => {
	it("returns nothing when no allow-list is configured", () => {
		// `undefined` is the explicit "not configured" signal, same as in
		// deriveBuiltInTools. Clamping here would restrict sessions that were
		// never meant to be restricted.
		expect(deriveBuiltInDisallowedTools(undefined)).toEqual([]);
	});

	it("leaves an unrestricted builder unclamped", () => {
		// A bare `Bash` grant means unrestricted by intent. These are the
		// personas that have to commit, push and open PRs; narrowing them would
		// break the product's main path.
		expect(
			deriveBuiltInDisallowedTools(["Read", "Write", "Edit", "Bash"]),
		).toEqual([]);
		expect(
			deriveBuiltInDisallowedTools(["Read", "Write", "Edit", "Bash(*)"]),
		).toEqual([]);
	});

	it("denies every write-capable built-in for a readOnly persona", () => {
		const denied = deriveBuiltInDisallowedTools([
			...SLACK_DEFAULT_ALLOWED_TOOLS,
		]);

		expect(denied).toContain("Write");
		expect(denied).toContain("Edit");
		expect(denied).toContain("NotebookEdit");
	});

	it("denies the shell routes around a denied Edit", () => {
		// The shell is what makes every other deny cosmetic: a session denied
		// `Edit` can still edit in place with `sed -i`, commit by pointing git
		// at another directory, or merge a PR through the GitHub API.
		const denied = deriveBuiltInDisallowedTools([
			...SLACK_DEFAULT_ALLOWED_TOOLS,
		]);

		for (const rule of [
			"Bash(sed:*)",
			"Bash(perl:*)",
			"Bash(git commit:*)",
			"Bash(git push:*)",
			"Bash(gh api:*)",
			"Bash(gh pr merge:*)",
			"Bash(rm:*)",
			"Bash(sudo:*)",
		]) {
			expect(denied).toContain(rule);
		}
	});

	it("keeps mcp__linear reachable", () => {
		// A read-only reviewer posts its findings through Linear. Denying the
		// MCP server would leave it able to read code and unable to say anything
		// about it.
		const denied = deriveBuiltInDisallowedTools([...REVIEW_ALLOWED_TOOLS]);

		expect(denied.some((rule) => rule.startsWith("mcp__"))).toBe(false);
	});

	it("never denies a shell command the allow-list actually granted", () => {
		// Deny beats allow everywhere, so a derived deny that contradicts an
		// explicit grant would silently revoke it. A persona granted
		// `Bash(git commit:*)` must keep it.
		const denied = deriveBuiltInDisallowedTools([
			"Read",
			"Bash(git commit:*)",
			"Bash(git push:*)",
		]);

		expect(denied).not.toContain("Bash(git commit:*)");
		expect(denied).not.toContain("Bash(git push:*)");
		// Unrelated mutating commands are still denied.
		expect(denied).toContain("Bash(sed:*)");
		expect(denied).toContain("Bash(rm:*)");
	});

	it("does not deny a write tool the allow-list granted", () => {
		const denied = deriveBuiltInDisallowedTools(["Read", "Edit"]);

		expect(denied).not.toContain("Edit");
		expect(denied).toContain("Write");
		expect(denied).toContain("NotebookEdit");
	});

	it("does not deny the readOnly persona's own git pull grant", () => {
		// The Slack preset's one shell grant. If the derivation denied any rule
		// that matched it, the persona would lose the only command it has.
		const denied = deriveBuiltInDisallowedTools([
			...SLACK_DEFAULT_ALLOWED_TOOLS,
		]);

		expect(
			denied.some((rule) =>
				commandMatchesAllowedBash("git -C /repo pull", [rule]),
			),
		).toBe(false);
	});

	it("emits only well-formed rules", () => {
		const denied = deriveBuiltInDisallowedTools([
			...SLACK_DEFAULT_ALLOWED_TOOLS,
		]);

		for (const rule of denied) {
			expect(rule).toMatch(/^(Write|Edit|NotebookEdit|Bash\(.+\))$/);
		}
	});
});

describe("ClaudeRunner wires the derived deny list into the SDK (CYR-25)", () => {
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

	// The regression test for the whole ticket. Before this change the ladder
	// resolved to `[]` for every session, so `disallowedTools` was never set and
	// the one layer that survives both the sandbox auto-allow and settings-file
	// shadowing was simply absent.
	it("sets disallowedTools for a readOnly session", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		expect(options.disallowedTools).toBeDefined();
		expect(options.disallowedTools).toContain("Write");
		expect(options.disallowedTools).toContain("Edit");
		expect(options.disallowedTools).toContain("NotebookEdit");
		expect(options.disallowedTools).toContain("Bash(sed:*)");
		expect(options.disallowedTools).toContain("Bash(git push:*)");
	});

	// This is the property the ticket exists to establish. A `permissions.allow`
	// entry in `~/.claude/settings.json` or the checked-out repo's
	// `.claude/settings.json` can auto-approve a command that `canUseTool` would
	// refuse — the SDK says so itself and does not surface which rules apply.
	// Cyrus passes settingSources: ["user","project","local"], so those files
	// are live. A deny rule is the only layer that outranks them, so the
	// write tools must appear in `disallowedTools` and not merely be absent
	// from `tools`.
	it("denies the write tools outright, not merely by omission from tools", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		for (const tool of ["Write", "Edit", "NotebookEdit"]) {
			// Absent from context…
			expect(options.tools).not.toContain(tool);
			// …AND refused even if something re-introduces it.
			expect(options.disallowedTools).toContain(tool);
		}
	});

	it("still merges explicitly configured denials", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
			disallowedTools: ["WebFetch"],
		});

		expect(options.disallowedTools).toContain("WebFetch");
		expect(options.disallowedTools).toContain("Write");
	});

	it("does not clamp an unrestricted builder", async () => {
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: ["Read", "Write", "Edit", "Bash"],
		});

		const denied: string[] = options.disallowedTools ?? [];
		for (const rule of MUTATING_BASH_DENY_RULES) {
			expect(denied).not.toContain(rule);
		}
		expect(denied).not.toContain("Write");
		expect(denied).not.toContain("Edit");
	});

	it("keeps the CYR-20 canUseTool layer installed alongside the deny list", async () => {
		// The two are complementary and neither replaces the other: deny rules
		// survive shadowing but only match command prefixes, while canUseTool
		// gives per-command precision over the grants. Removing either one
		// reopens a hole the other does not cover.
		const options = await captureQueryOptions({
			workingDirectory: "/test",
			cyrusHome: "/test/cyrus",
			allowedTools: [...SLACK_DEFAULT_ALLOWED_TOOLS],
		});

		expect(options.canUseTool).toBeTypeOf("function");
		expect(options.disallowedTools.length).toBeGreaterThan(0);
	});
});
