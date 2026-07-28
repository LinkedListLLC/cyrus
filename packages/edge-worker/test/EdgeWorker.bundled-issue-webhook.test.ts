import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { EdgeWorkerConfig, RepositoryConfig } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

/**
 * One Linear save can change several fields, and Linear packs every one of them
 * into a single `updatedFrom`. Renaming an issue as you move it to another state
 * is one save, so it arrives as one webhook that is a content update *and* a
 * state change.
 *
 * The router used to test the two predicates as `else if` branches with the
 * content one first. First match wins, so a state change bundled with a title,
 * description or attachment change went to the content handler and the state
 * handler never ran.
 *
 * The guards themselves were never wrong — `EdgeWorker.issue-state-change.test.ts`
 * already pins that both match the combined shape. The defect was in what the
 * router did with that. These tests drive the real router so the dispatch is a
 * pinned property rather than an assumption.
 */
describe("EdgeWorker - one webhook that is both content and state", () => {
	let mockAgentSessionManager: any;

	function buildRepository(): RepositoryConfig {
		return {
			id: "test-repo",
			name: "Test Repo",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspaces",
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
			teamKeys: ["TEST"],
		} as RepositoryConfig;
	}

	function buildConfig(): EdgeWorkerConfig {
		return {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [buildRepository()],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as EdgeWorkerConfig;
	}

	function buildWebhook(updatedFrom: Record<string, unknown>): any {
		return {
			type: "Issue",
			action: "update",
			organizationId: "test-workspace",
			createdAt: "2026-07-27T17:47:49Z",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Renamed",
				stateId: "state-in-review",
			},
			updatedFrom,
		};
	}

	function createWorker(): EdgeWorker {
		const worker = new EdgeWorker(buildConfig());
		(worker as any).agentSessionManager = mockAgentSessionManager;
		(worker as any).issueTrackers = new Map([
			[
				"test-workspace",
				{
					fetchIssue: vi.fn().mockResolvedValue({
						id: "issue-1",
						identifier: "TEST-1",
						state: Promise.resolve({ name: "In Review", type: "started" }),
					}),
				},
			],
		]);
		return worker;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(
			() => ({ server: {} }) as any,
		);

		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue(null),
			setActivitySink: vi.fn(),
			addAgentRunner: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123", name: "Test User" }),
				},
			};
		} as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs BOTH handlers, not whichever predicate matched first", async () => {
		const worker = createWorker();
		const content = vi
			.spyOn(worker as any, "handleIssueContentUpdate")
			.mockResolvedValue(undefined);
		const state = vi
			.spyOn(worker as any, "handleIssueStateChange")
			.mockResolvedValue(undefined);

		await (worker as any).handleWebhook(
			buildWebhook({ stateId: "state-in-progress", title: "Test Issue" }),
			[buildRepository()],
		);

		expect(content).toHaveBeenCalledTimes(1);
		expect(state).toHaveBeenCalledTimes(1);
	});

	it("still runs only the content handler when no stateId changed", async () => {
		const worker = createWorker();
		const content = vi
			.spyOn(worker as any, "handleIssueContentUpdate")
			.mockResolvedValue(undefined);
		const state = vi
			.spyOn(worker as any, "handleIssueStateChange")
			.mockResolvedValue(undefined);

		await (worker as any).handleWebhook(buildWebhook({ title: "Test Issue" }), [
			buildRepository(),
		]);

		expect(content).toHaveBeenCalledTimes(1);
		expect(state).not.toHaveBeenCalled();
	});

	it("still runs only the state handler when no content changed", async () => {
		const worker = createWorker();
		const content = vi
			.spyOn(worker as any, "handleIssueContentUpdate")
			.mockResolvedValue(undefined);
		const state = vi
			.spyOn(worker as any, "handleIssueStateChange")
			.mockResolvedValue(undefined);

		await (worker as any).handleWebhook(
			buildWebhook({ stateId: "state-in-progress" }),
			[buildRepository()],
		);

		expect(content).not.toHaveBeenCalled();
		expect(state).toHaveBeenCalledTimes(1);
	});
});
