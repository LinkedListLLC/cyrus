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
		// The review now starts inline from the mint result, so let it "start"
		// successfully — a review that fails to start releases the guard on
		// purpose (covered by the minting-failure test below).
		(worker as any).initializeReviewRunner = vi
			.fn()
			.mockResolvedValue(undefined);

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

	/**
	 * CYR-16 / B5. Linear documents `AgentSessionEvent`/`created` only for human
	 * delegation and @mention, and says nothing about echoing back a session an
	 * app creates for itself. So the review must not wait for that echo.
	 */
	it("starts the review from the mint result, without any webhook echo", async () => {
		const worker = createWorker("In Review", "In Review");
		const initializeReviewRunner = vi.fn().mockResolvedValue(undefined);
		const initializeAgentRunner = vi.fn().mockResolvedValue(undefined);
		(worker as any).initializeReviewRunner = initializeReviewRunner;
		(worker as any).initializeAgentRunner = initializeAgentRunner;

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		// No agentSessionCreated webhook was delivered at all.
		expect(initializeReviewRunner).toHaveBeenCalledTimes(1);
		expect(initializeAgentRunner).not.toHaveBeenCalled();

		const [sessionId, context] = initializeReviewRunner.mock.calls[0]!;
		expect(sessionId).toBe("review-session-1");
		expect(context).toMatchObject({
			issueId: "issue-1",
			issueIdentifier: "TEST-1",
			repositoryId: "test-repo",
			stateName: "In Review",
		});
	});

	it("swallows Linear's echo of the minted session instead of double-starting", async () => {
		const worker = createWorker("In Review", "In Review");
		const initializeReviewRunner = vi.fn().mockResolvedValue(undefined);
		const initializeAgentRunner = vi.fn().mockResolvedValue(undefined);
		(worker as any).initializeReviewRunner = initializeReviewRunner;
		(worker as any).initializeAgentRunner = initializeAgentRunner;

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		// If Linear *does* echo the mint, it must be a no-op — neither a second
		// review nor (worse) a builder session on the review's own session id.
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
	});

	/**
	 * CYR-16 / B4. The marker used to be keyed by issue id and handed to any
	 * session arriving on that issue within 5 minutes. This races a human
	 * delegation against an in-flight mint: previously the human session was
	 * handed the review marker and ran read-only, while the real review session
	 * found no marker and ran as a full builder with write tools.
	 */
	it("does not let a human session arriving mid-mint steal the review marker", async () => {
		const worker = createWorker("In Review", "In Review");
		const initializeReviewRunner = vi.fn().mockResolvedValue(undefined);
		const initializeAgentRunner = vi.fn().mockResolvedValue(undefined);
		(worker as any).initializeReviewRunner = initializeReviewRunner;
		(worker as any).initializeAgentRunner = initializeAgentRunner;

		// Hold the mint open so the human delegation genuinely lands mid-flight.
		let releaseMint: (payload: any) => void = () => {};
		mockIssueTracker.createAgentSessionOnIssue = vi.fn(
			() =>
				new Promise((resolve) => {
					releaseMint = resolve;
				}),
		);

		const triggerDone = (worker as any).handleIssueStateChange(
			createStateChangeWebhook(),
		);
		// Let the trigger reach the mint call and register the in-flight review.
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);

		// A human delegates the same issue while the mint is still open.
		const humanDone = (worker as any).handleAgentSessionCreatedWebhook(
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

		releaseMint({
			success: true,
			agentSession: Promise.resolve({ id: "review-session-1" }),
		});
		await triggerDone;
		await humanDone;

		// Exactly one review, and it is the session we minted.
		expect(initializeReviewRunner).toHaveBeenCalledTimes(1);
		expect(initializeReviewRunner.mock.calls[0]![0]).toBe("review-session-1");

		// The human session stayed a builder session.
		expect(initializeAgentRunner).toHaveBeenCalledTimes(1);
		expect(initializeAgentRunner.mock.calls[0]![0].id).toBe("human-session-1");
	});

	/**
	 * CYR-16 / B2. A detached review worktree keeps its refs and object store in
	 * the main repository, so sandboxing the reviewer to `worktree.path` alone
	 * breaks every `git diff`/`git log` the review is built on — the failure
	 * GitService's own docstring describes as "Operation not permitted".
	 */
	it("gives the review read access to the repo and its git metadata, not just the worktree", async () => {
		const worker = createWorker("In Review", "In Review");
		const buildAgentRunnerConfig = vi
			.fn()
			.mockResolvedValue({ config: {}, runnerType: "claude" });
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
		(worker as any).convertLinearIssueToCore = vi
			.fn()
			.mockReturnValue({ id: "issue-1", branchName: "TEST-1-feature" });
		(worker as any).savePersistedState = vi.fn().mockResolvedValue(undefined);
		(worker as any).activityPoster = {
			postThoughtActivity: vi.fn().mockResolvedValue(undefined),
		};
		(worker as any).getActivitySinkForRepo = vi.fn().mockReturnValue(undefined);
		mockAgentSessionManager.getSession = vi
			.fn()
			.mockReturnValue({ id: "review-session-1", metadata: {} });

		(worker as any).gitService = {
			createReviewWorktree: vi.fn().mockResolvedValue({
				path: "/test/workspaces/reviews/TEST-1-review-session-1",
				checkoutRef: "origin/TEST-1-feature",
				repositoryPath: "/test/repo",
				usedFallbackRef: false,
			}),
			// The real resolution of a linked worktree: both live in the main repo.
			getGitMetadataDirectories: vi
				.fn()
				.mockReturnValue([
					"/test/repo/.git/worktrees/TEST-1-review-session-1",
					"/test/repo/.git",
				]),
			removeReviewWorktree: vi.fn(),
		};

		await (worker as any).handleIssueStateChange(createStateChangeWebhook());

		expect(buildAgentRunnerConfig).toHaveBeenCalledTimes(1);
		const allowedDirectories = buildAgentRunnerConfig.mock.calls[0]![5];

		expect(allowedDirectories).toContain(
			"/test/workspaces/reviews/TEST-1-review-session-1",
		);
		// Without these the sandbox denies the reviewer its own git object store.
		expect(allowedDirectories).toContain("/test/repo");
		expect(allowedDirectories).toContain(
			"/test/repo/.git/worktrees/TEST-1-review-session-1",
		);
		expect(allowedDirectories).toContain("/test/repo/.git");
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
		const [
			,
			,
			,
			systemPrompt,
			allowedTools,
			,
			disallowedTools,
			,
			resumeLabels,
			resumeDescription,
		] = buildAgentRunnerConfig.mock.calls[0]!;

		expect(systemPrompt).toBe("REVIEW PROMPT");
		// Issue-controlled text must not pick the runner for a review on resume,
		// exactly as on the first run.
		expect(resumeLabels).toBeUndefined();
		expect(resumeDescription).toBeUndefined();
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
