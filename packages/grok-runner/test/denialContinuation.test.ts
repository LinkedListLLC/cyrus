import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives a whole turn against a fake ACP agent to prove the fix for the
 * behaviour observed on CYR-12: a policy denial ended the turn, so the session
 * posted only the half-finished sentence it had streamed before the attempt.
 */

type RequestLog = { method: string; params: unknown };

const requests: RequestLog[] = [];
/** Permission requests the fake agent will raise, in order. */
let pendingPermissionRequests: unknown[] = [];

class FakeAcpClient {
	private onAgentRequest: (
		method: string,
		params: unknown,
	) => Promise<unknown> | unknown;

	constructor(options: {
		onAgentRequest: (m: string, p: unknown) => Promise<unknown> | unknown;
	}) {
		this.onAgentRequest = options.onAgentRequest;
	}

	async start(): Promise<void> {}

	/** Both are called by the runner during teardown. */
	isRunning(): boolean {
		return false;
	}

	kill(_signal?: string): void {}

	async request(method: string, params: unknown): Promise<unknown> {
		requests.push({ method, params });

		switch (method) {
			case "initialize":
				return {
					protocolVersion: 1,
					agentCapabilities: { mcpCapabilities: { http: true } },
					authMethods: [{ id: "cached_token" }],
				};
			case "authenticate":
				return {};
			case "session/new":
				return { sessionId: "session-under-test" };
			case "session/prompt": {
				// On the first turn the agent tries a tool; the client's policy
				// decides. A denial is what historically ended the turn.
				const next = pendingPermissionRequests.shift();
				if (next) {
					await this.onAgentRequest("session/request_permission", next);
				}
				return { stopReason: "end_turn" };
			}
			default:
				return {};
		}
	}

	async close(): Promise<void> {}
}

vi.mock("../src/backend/AcpClient.js", () => ({
	AcpClient: FakeAcpClient,
	defaultHandleAgentRequest: () => ({ outcome: { outcome: "cancelled" } }),
}));

vi.mock("../src/grokBinary.js", () => ({
	resolveGrokBinary: () => "/usr/local/bin/grok",
	hasGrokCachedAuth: () => true,
}));

const { GrokRunner } = await import("../src/GrokRunner.js");

/** A permission request for a `write`, shaped like the real CYR-12 payload. */
const writePermissionRequest = {
	options: [
		{ optionId: "allow-once", kind: "allow_once", name: "Yes" },
		{ optionId: "reject-once", kind: "reject_once", name: "No" },
	],
	toolCall: {
		title: "write",
		_meta: {
			"x.ai/tool": { name: "write", kind: "write", read_only: false },
		},
	},
};

function promptCalls() {
	return requests.filter((r) => r.method === "session/prompt");
}

function makeRunner(allowedTools?: string[]) {
	return new GrokRunner({
		cyrusHome: "/tmp/cyrus-test",
		workingDirectory: "/tmp",
		...(allowedTools ? { allowedTools } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: test config shim
	} as any);
}

describe("continuing a turn after a policy denial", () => {
	beforeEach(() => {
		requests.length = 0;
		pendingPermissionRequests = [];
	});

	it("re-prompts so the agent finishes instead of stopping at the refusal", async () => {
		pendingPermissionRequests = [writePermissionRequest];
		// A read-only allow-list, which denies Write.
		await makeRunner(["Read(**)", "mcp__linear"]).start("review this");

		const prompts = promptCalls();
		expect(prompts).toHaveLength(2);

		const continuation = JSON.stringify(prompts[1]?.params);
		expect(continuation).toContain("blocked by this session's tool policy");
		expect(continuation).toContain("write");
		// It must be told this is standing policy, not a human interrupting,
		// otherwise it retries the same call.
		expect(continuation).toContain("not a human interrupting");
	});

	it("does not re-prompt when nothing was denied", async () => {
		pendingPermissionRequests = [];
		await makeRunner(["Read(**)"]).start("just read");
		expect(promptCalls()).toHaveLength(1);
	});

	it("does not re-prompt when the session is unrestricted", async () => {
		// No allow-list ⇒ no deny rules ⇒ the request is approved, not denied.
		pendingPermissionRequests = [writePermissionRequest];
		await makeRunner().start("do work");
		expect(promptCalls()).toHaveLength(1);
	});

	it("stops after the cap rather than ping-ponging forever", async () => {
		// The agent reaches for the denied tool on every turn.
		pendingPermissionRequests = [
			writePermissionRequest,
			writePermissionRequest,
			writePermissionRequest,
			writePermissionRequest,
		];
		await makeRunner(["Read(**)"]).start("keep trying");

		// 1 original + MAX_DENIAL_CONTINUATIONS (2)
		expect(promptCalls()).toHaveLength(3);
	});
});
