import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
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
 * CYR-53: a session killed mid-turn can die before the Claude CLI writes its
 * transcript. The conversation ID stays on the Cyrus session, so every later
 * prompt resumes an ID the CLI cannot find:
 *
 *   "No conversation found with session ID: 48614c4d-..."
 *
 * The session must recover by replaying the prompt as a fresh session, not
 * dead-end on that error.
 */
describe("EdgeWorker - stale resume recovery (CYR-53)", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;

	const sessionId = "agent-session-stale";

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
		teamKeys: ["TEST"],
	};

	function missingConversationResult(overrides: any = {}) {
		return {
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			duration_ms: 1,
			duration_api_ms: 1,
			num_turns: 1,
			result:
				"No conversation found with session ID: 48614c4d-0cb5-4c32-97e2-67e3c6b2f33c",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-stale",
			session_id: "sdk-session",
			...overrides,
		} as any;
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
				startStreaming: vi.fn().mockResolvedValue({ sessionId: "claude-1" }),
				stop: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			handleClaudeMessage: vi.fn().mockResolvedValue(undefined),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			clearRunnerSessionIds: vi.fn(),
			getSession: vi.fn().mockReturnValue(null),
			setActivitySink: vi.fn(),
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
			return { users: { me: vi.fn().mockResolvedValue({ id: "user-1" }) } };
		} as any);

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replays the prompt as a fresh session when the conversation is gone", async () => {
		const retry = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).staleResumeRecoveryBySession.set(sessionId, retry);

		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			missingConversationResult(),
			"test-repo",
		);

		expect(retry).toHaveBeenCalledTimes(1);
		// The raw SDK error never reaches the timeline — the work is not lost.
		expect(mockAgentSessionManager.handleClaudeMessage).not.toHaveBeenCalled();
		// The user is told why the session restarted.
		expect(mockAgentSessionManager.createThoughtActivity).toHaveBeenCalled();
	});

	it("reads the missing-conversation text out of the errors array too", async () => {
		const retry = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).staleResumeRecoveryBySession.set(sessionId, retry);

		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			missingConversationResult({
				result: undefined,
				errors: ["No conversation found with session ID: 48614c4d"],
			}),
			"test-repo",
		);

		expect(retry).toHaveBeenCalledTimes(1);
	});

	it("retries at most once per resume attempt", async () => {
		const retry = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).staleResumeRecoveryBySession.set(sessionId, retry);

		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			missingConversationResult(),
			"test-repo",
		);
		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			missingConversationResult(),
			"test-repo",
		);

		expect(retry).toHaveBeenCalledTimes(1);
		// The second result is a normal error and belongs on the timeline.
		expect(mockAgentSessionManager.handleClaudeMessage).toHaveBeenCalledTimes(
			1,
		);
	});

	it("passes unrelated error results straight through", async () => {
		const retry = vi.fn().mockResolvedValue(undefined);
		(edgeWorker as any).staleResumeRecoveryBySession.set(sessionId, retry);

		const message = missingConversationResult({
			result: "Some other failure",
		});
		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			message,
			"test-repo",
		);

		expect(retry).not.toHaveBeenCalled();
		expect(mockAgentSessionManager.handleClaudeMessage).toHaveBeenCalledWith(
			sessionId,
			message,
		);
	});

	it("passes results through when no resume is in flight", async () => {
		const message = missingConversationResult();

		await (edgeWorker as any).handleClaudeMessage(
			sessionId,
			message,
			"test-repo",
		);

		expect(mockAgentSessionManager.handleClaudeMessage).toHaveBeenCalledWith(
			sessionId,
			message,
		);
	});

	describe("wiring through resumeAgentSession", () => {
		const session: any = {
			id: sessionId,
			status: "active",
			claudeSessionId: "48614c4d-0cb5-4c32-97e2-67e3c6b2f33c",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-123",
				issueIdentifier: "TEST-123",
			},
			repositories: [],
			workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
			agentRunner: {
				supportsStreamingInput: true,
				isRunning: vi.fn().mockReturnValue(true),
				addStreamMessage: vi.fn(),
				stop: vi.fn(),
			},
		};

		let startStreaming: any;

		beforeEach(() => {
			session.claudeSessionId = "48614c4d-0cb5-4c32-97e2-67e3c6b2f33c";
			session.agentRunner = {
				supportsStreamingInput: true,
				// A runner is still "running" while it emits its final result.
				isRunning: vi.fn().mockReturnValue(true),
				addStreamMessage: vi.fn(),
				stop: vi.fn(),
			};

			mockAgentSessionManager.getSession.mockReturnValue(session);
			mockAgentSessionManager.addAgentRunner = vi.fn();
			mockAgentSessionManager.detachAgentRunner = vi.fn(() => {
				session.agentRunner = undefined;
			});
			mockAgentSessionManager.clearRunnerSessionIds = vi.fn(() => {
				session.claudeSessionId = undefined;
			});

			startStreaming = vi.fn().mockResolvedValue({ sessionId: "claude-1" });

			vi.spyOn(edgeWorker as any, "fetchFullIssueDetails").mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
			});
			vi.spyOn(edgeWorker as any, "fetchIssueLabels").mockResolvedValue([]);
			vi.spyOn(
				edgeWorker as any,
				"determineSystemPromptFromLabels",
			).mockResolvedValue(undefined);
			vi.spyOn(edgeWorker as any, "buildAgentRunnerConfig").mockResolvedValue({
				config: {},
				runnerType: "claude",
			});
			vi.spyOn(edgeWorker as any, "createRunnerForType").mockReturnValue({
				supportsStreamingInput: true,
				startStreaming,
				isRunning: vi.fn().mockReturnValue(false),
				stop: vi.fn(),
			});
			vi.spyOn(edgeWorker as any, "buildSessionPrompt").mockResolvedValue(
				"prompt",
			);
			vi.spyOn(edgeWorker as any, "savePersistedState").mockResolvedValue(
				undefined,
			);
		});

		async function resumeOnce() {
			await (edgeWorker as any).resumeAgentSession(
				session,
				mockRepository,
				sessionId,
				mockAgentSessionManager,
				"Please carry on",
				"",
				false,
				[],
				"test-workspace",
			);
		}

		it("restarts the turn with the full issue context when the conversation is gone", async () => {
			// The runner is not running yet, so the resume takes the restart path.
			session.agentRunner.isRunning.mockReturnValue(false);
			await resumeOnce();

			const buildSessionPrompt = vi.mocked(
				(edgeWorker as any).buildSessionPrompt,
			);
			expect(buildSessionPrompt.mock.calls[0][0]).toBe(false); // isNewSession
			expect(
				(edgeWorker as any).staleResumeRecoveryBySession.has(sessionId),
			).toBe(true);

			// The new runner is mid-unwind and reports the lost conversation.
			session.agentRunner = {
				supportsStreamingInput: true,
				isRunning: vi.fn().mockReturnValue(true),
				addStreamMessage: vi.fn(),
				stop: vi.fn(),
			};
			await (edgeWorker as any).handleClaudeMessage(
				sessionId,
				missingConversationResult(),
				"test-repo",
			);

			// The dying runner never receives the replayed prompt...
			expect(session.agentRunner).toBeUndefined();
			expect(mockAgentSessionManager.detachAgentRunner).toHaveBeenCalledWith(
				sessionId,
			);
			// ...the dead conversation ID is forgotten...
			expect(
				mockAgentSessionManager.clearRunnerSessionIds,
			).toHaveBeenCalledWith(sessionId);
			// ...and the same prompt runs again with the full issue context.
			expect(buildSessionPrompt).toHaveBeenCalledTimes(2);
			expect(buildSessionPrompt.mock.calls[1][0]).toBe(true); // isNewSession
			expect(buildSessionPrompt.mock.calls[1][4]).toBe("Please carry on");
			expect(startStreaming).toHaveBeenCalledTimes(2);
		});

		it("registers no recovery when there is nothing to resume", async () => {
			session.claudeSessionId = undefined;
			session.agentRunner = undefined;

			await resumeOnce();

			expect(
				(edgeWorker as any).staleResumeRecoveryBySession.has(sessionId),
			).toBe(false);
		});
	});

	it("keeps the follow-up SDK throw out of the error reporter", async () => {
		const errorSpy = vi.spyOn((edgeWorker as any).logger, "error");

		await (edgeWorker as any).handleClaudeError(
			new Error(
				"Claude Code returned an error result: No conversation found with session ID: 48614c4d",
			),
		);

		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("still reports genuinely unhandled errors", async () => {
		const errorSpy = vi.spyOn((edgeWorker as any).logger, "error");

		await (edgeWorker as any).handleClaudeError(new Error("kaboom"));

		expect(errorSpy).toHaveBeenCalled();
	});
});
