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

// Mock all dependencies (mirrors EdgeWorker.pr-review-trigger.test.ts)
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
 * CYR-5: a transition into the repository's configured `reviewOnStatus` state
 * starts exactly one fresh, read-only review session — and nothing else does.
 */
describe("EdgeWorker - reviewOnStatus trigger (CYR-5)", () => {
	let mockAgentSessionManager: any;
	let mockIssueTracker: any;

	function buildRepository(
		reviewOnStatus: string | undefined,
	): RepositoryConfig {
		return {
			id: "test-repo",
			name: "Test Repo",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspaces",
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
			teamKeys: ["TEST"],
			...(reviewOnStatus === undefined ? {} : { reviewOnStatus }),
		} as RepositoryConfig;
	}

	function buildConfig(reviewOnStatus: string | undefined): EdgeWorkerConfig {
		return {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [buildRepository(reviewOnStatus)],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as EdgeWorkerConfig;
	}

	/** An `Issue`/`update` webhook whose `updatedFrom` carries the old stateId. */
	function createStateChangeWebhook(overrides: Record<string, any> = {}): any {
		return {
			type: "Issue",
			action: "update",
			organizationId: "test-workspace",
			createdAt: "2025-01-01T00:00:00Z",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-in-review",
			},
			updatedFrom: { stateId: "state-in-progress" },
			...overrides,
		};
	}

	function createWorker(
		reviewOnStatus: string | undefined,
		stateName: string,
		stateType = "started",
	): EdgeWorker {
		const worker = new EdgeWorker(buildConfig(reviewOnStatus));
		(worker as any).agentSessionManager = mockAgentSessionManager;

		mockIssueTracker = {
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-1",
				identifier: "TEST-1",
				state: Promise.resolve({ name: stateName, type: stateType }),
			}),
			createAgentSessionOnIssue: vi.fn().mockResolvedValue({
				success: true,
				agentSession: Promise.resolve({ id: "review-session-1" }),
			}),
		};
		(worker as any).issueTrackers = new Map([
			["test-workspace", mockIssueTracker],
		]);

		// The issue routes to the repo (as it would after a builder session ran).
		(worker as any).resolveRepositoryForIssue = vi
			.fn()
			.mockReturnValue(buildRepository(reviewOnStatus));

		return worker;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

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
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
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

	it("mints a fresh agent session when the issue enters the configured state", async () => {
		const worker = createWorker("In Review", "In Review");

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledWith({
			issueId: "issue-1",
		});
	});

	it("matches the state name case-insensitively", async () => {
		const worker = createWorker("in review", "In Review");

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the new state is not the configured one", async () => {
		const worker = createWorker("In Review", "In Progress");

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("does nothing when reviewOnStatus is not configured", async () => {
		const worker = createWorker(undefined, "In Review");

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("does not spawn a duplicate review for a replayed webhook", async () => {
		const worker = createWorker("In Review", "In Review");
		const webhook = createStateChangeWebhook();

		await (worker as any).handleIssueStateChange(webhook);
		await (worker as any).handleIssueStateChange(webhook);

		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
	});

	it("does not spawn a second review while one is already in flight", async () => {
		const worker = createWorker("In Review", "In Review");

		// A distinct webhook (different createdAt) for the same issue — e.g. the
		// user bounced the issue out of and back into "In Review".
		await (worker as any).handleIssueStateChange(createStateChangeWebhook());
		await (worker as any).handleIssueStateChange(
			createStateChangeWebhook({ createdAt: "2025-01-01T00:05:00Z" }),
		);

		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
	});

	it("does not review when no repository can be resolved for the issue", async () => {
		const worker = createWorker("In Review", "In Review");
		(worker as any).resolveRepositoryForIssue = vi.fn().mockReturnValue(null);

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("does not review on a terminal transition, leaving wind-down untouched", async () => {
		const worker = createWorker("Done", "Done", "completed");

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(mockIssueTracker.createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("releases the in-flight guard when minting fails, so a retry can run", async () => {
		const worker = createWorker("In Review", "In Review");
		mockIssueTracker.createAgentSessionOnIssue = vi
			.fn()
			.mockRejectedValueOnce(new Error("linear down"))
			.mockResolvedValueOnce({
				success: true,
				agentSession: Promise.resolve({ id: "review-session-2" }),
			});

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());
		await (worker as any).handleIssueStateChange(
			createStateChangeWebhook({ createdAt: "2025-01-01T00:05:00Z" }),
		);

		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(2);
	});

	it("routes the minted session's created-webhook to the review runner, not the builder", async () => {
		const worker = createWorker("In Review", "In Review");
		const initializeReviewRunner = vi.fn().mockResolvedValue(undefined);
		const initializeAgentRunner = vi.fn().mockResolvedValue(undefined);
		(worker as any).initializeReviewRunner = initializeReviewRunner;
		(worker as any).initializeAgentRunner = initializeAgentRunner;

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		// Linear echoes the mint back as a normal agentSessionCreated webhook.
		await (worker as any).handleAgentSessionCreatedWebhook(
			{
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "test-workspace",
				agentSession: {
					id: "review-session-1",
					issue: { id: "issue-1", identifier: "TEST-1" },
				},
			},
			[buildRepository("In Review")],
		);

		expect(initializeReviewRunner).toHaveBeenCalledTimes(1);
		expect(initializeAgentRunner).not.toHaveBeenCalled();

		const [, context] = initializeReviewRunner.mock.calls[0]!;
		expect(context).toMatchObject({
			issueId: "issue-1",
			issueIdentifier: "TEST-1",
			repositoryId: "test-repo",
			stateName: "In Review",
		});
	});

	it("keeps the review read-only when a follow-up comment resumes it", async () => {
		const worker = createWorker("In Review", "In Review");
		const buildAgentRunnerConfig = vi.fn().mockResolvedValue({
			config: {},
			runnerType: "claude",
		});
		(worker as any).buildAgentRunnerConfig = buildAgentRunnerConfig;
		(worker as any).createRunnerForType = vi.fn().mockReturnValue({
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-1" }),
			isRunning: vi.fn().mockReturnValue(false),
			stop: vi.fn(),
		});
		(worker as any).fetchFullIssueDetails = vi.fn().mockResolvedValue({
			id: "issue-1",
			identifier: "TEST-1",
			title: "Test Issue",
			description: "",
		});
		(worker as any).fetchIssueLabels = vi.fn().mockResolvedValue(["builder"]);
		(worker as any).determineSystemPromptFromLabels = vi
			.fn()
			.mockResolvedValue({ prompt: "BUILDER PROMPT", type: "builder" });
		// The builder toolset that must NOT come back on resume.
		(worker as any).buildAllowedTools = vi
			.fn()
			.mockReturnValue(["Read", "Edit", "Write", "Bash"]);
		(worker as any).buildDisallowedTools = vi.fn().mockReturnValue([]);
		(worker as any).buildSessionPrompt = vi.fn().mockResolvedValue("follow-up");
		(worker as any).savePersistedState = vi.fn().mockResolvedValue(undefined);

		const reviewSession: any = {
			id: "review-session-1",
			issueId: "issue-1",
			issueContext: { issueId: "issue-1", issueIdentifier: "TEST-1" },
			workspace: { path: "/tmp/reviews/TEST-1", isGitWorktree: true },
			claudeSessionId: "claude-existing",
			metadata: {
				readOnlyReview: true,
				reviewSystemPrompt: "REVIEW PROMPT",
			},
		};

		await (worker as any).resumeAgentSession(
			reviewSession,
			buildRepository("In Review"),
			"review-session-1",
			mockAgentSessionManager,
			"can you just fix it for me?",
		);

		expect(buildAgentRunnerConfig).toHaveBeenCalledTimes(1);
		const [, , , systemPrompt, allowedTools, , disallowedTools] =
			buildAgentRunnerConfig.mock.calls[0]!;

		expect(systemPrompt).toBe("REVIEW PROMPT");
		expect(allowedTools).not.toContain("Edit");
		expect(allowedTools).not.toContain("Write");
		expect(allowedTools).not.toContain("Bash");
		expect(allowedTools).toContain("mcp__linear");
		expect(disallowedTools).toContain("Edit");
		expect(disallowedTools).toContain("Write");
	});

	it("leaves an unrelated agent session on the same issue as a builder session", async () => {
		const worker = createWorker("In Review", "In Review");
		const initializeReviewRunner = vi.fn().mockResolvedValue(undefined);
		const initializeAgentRunner = vi.fn().mockResolvedValue(undefined);
		(worker as any).initializeReviewRunner = initializeReviewRunner;
		(worker as any).initializeAgentRunner = initializeAgentRunner;

		// No review was ever triggered — a human delegation must not be hijacked.
		await (worker as any).handleAgentSessionCreatedWebhook(
			{
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "test-workspace",
				agentSession: {
					id: "human-session-1",
					issue: { id: "issue-1", identifier: "TEST-1" },
				},
			},
			[buildRepository("In Review")],
		);

		expect(initializeReviewRunner).not.toHaveBeenCalled();
		expect(initializeAgentRunner).toHaveBeenCalledTimes(1);
	});
});
