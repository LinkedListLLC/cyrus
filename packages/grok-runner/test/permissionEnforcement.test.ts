import { describe, expect, it } from "vitest";
import {
	buildRejectionOutcome,
	evaluatePermissionRequest,
	translateToolRules,
} from "../src/toolPolicy.js";

/**
 * The policy a `readOnly` persona produces. Verified live on CYR-9: these deny
 * flags reached the CLI and were ignored, which is why enforcement moved here.
 */
const READ_ONLY = translateToolRules([
	"Read(**)",
	"WebFetch",
	"WebSearch",
	"mcp__linear",
]);

/**
 * A real `session/request_permission` payload shape, taken from the CYR-9 wire
 * log entry for the write that should have been blocked.
 */
const writeRequest = {
	options: [
		{ optionId: "allow-once", kind: "allow_once", name: "Yes" },
		{ optionId: "reject-once", kind: "reject_once", name: "No, reject" },
	],
	toolCall: {
		toolCallId: "call-54c2e9b4-3",
		title: "write",
		rawInput: {
			file_path: "/root/.cyrus/worktrees/CYR-9/permission-probe.txt",
		},
		_meta: {
			"x.ai/tool": {
				version: 1,
				name: "write",
				kind: "write",
				namespace: "opencode",
				label: "Write",
				read_only: false,
			},
		},
	},
};

describe("evaluatePermissionRequest", () => {
	it("denies the exact write that slipped through on CYR-9", () => {
		const verdict = evaluatePermissionRequest(writeRequest, READ_ONLY);
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toMatch(/Write|Edit/);
	});

	it("allows anything when no restriction is in force", () => {
		expect(evaluatePermissionRequest(writeRequest, { deny: [] }).allowed).toBe(
			true,
		);
	});

	it("allows a tool that reports itself read-only", () => {
		const req = {
			toolCall: {
				title: "read_file",
				_meta: {
					"x.ai/tool": { name: "read_file", kind: "read", read_only: true },
				},
			},
		};
		expect(evaluatePermissionRequest(req, READ_ONLY).allowed).toBe(true);
	});

	it("denies shell execution when Bash is denied", () => {
		const req = {
			toolCall: {
				title: "run_terminal_command",
				_meta: {
					"x.ai/tool": { name: "run_terminal_command", kind: "execute" },
				},
			},
		};
		expect(evaluatePermissionRequest(req, READ_ONLY).allowed).toBe(false);
	});

	it("allows shell execution when Bash is NOT denied (scoped grant)", () => {
		// Mirrors the live config: a scoped Bash grant suppresses the blanket deny.
		const scoped = translateToolRules([
			"Read",
			"Bash(git -C * pull)",
			"mcp__linear",
		]);
		expect(scoped.deny).not.toContain("Bash");
		const req = {
			toolCall: {
				title: "run_terminal_command",
				_meta: { "x.ai/tool": { kind: "execute" } },
			},
		};
		expect(evaluatePermissionRequest(req, scoped).allowed).toBe(true);
	});

	it("understands ACP's own kind field without x.ai metadata", () => {
		const req = { toolCall: { kind: "edit", title: "Edit file" } };
		expect(evaluatePermissionRequest(req, READ_ONLY).allowed).toBe(false);
	});

	it("allows MCP calls to a granted server and denies a denied one", () => {
		const policy = translateToolRules(["Read"], ["mcp__github"]);
		const linear = { toolCall: { title: "linear__save_comment" } };
		const github = { toolCall: { title: "github__create_pr" } };
		expect(evaluatePermissionRequest(linear, policy).allowed).toBe(true);
		expect(evaluatePermissionRequest(github, policy).allowed).toBe(false);
	});

	it("fails closed on an unidentifiable request", () => {
		expect(evaluatePermissionRequest({ options: [] }, READ_ONLY).allowed).toBe(
			false,
		);
	});

	it("lets non-mutating tools through", () => {
		const req = { toolCall: { kind: "think", title: "think" } };
		expect(evaluatePermissionRequest(req, READ_ONLY).allowed).toBe(true);
	});
});

describe("buildRejectionOutcome", () => {
	it("picks the agent's reject option when offered", () => {
		expect(buildRejectionOutcome(writeRequest)).toEqual({
			outcome: { outcome: "selected", optionId: "reject-once" },
		});
	});

	it("cancels when no reject option is advertised", () => {
		expect(buildRejectionOutcome({ options: [] })).toEqual({
			outcome: { outcome: "cancelled" },
		});
	});
});
