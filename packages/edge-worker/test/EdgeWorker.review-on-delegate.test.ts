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
 * CYR-33: `reviewOnDelegateInStatus` — the second, opt-in route to a review.
 *
 * The status trigger needs an `Issue`/`update` webhook, which Linear sends only
 * to apps subscribed to the `Issue` resource type. `AgentSessionEvent`/`created`
 * always arrives, so delegating an issue that already sits in the review state
 * gives a review without touching the Linear app's configuration.
 *
 * The property that matters most here is the *negative* one: with the flag
 * unset — the default — delegation behaviour must be bit-for-bit unchanged.
 */
describe("EdgeWorker - reviewOnDelegateInStatus (CYR-33)", () => {
	let mockAgentSessionManager: any;

	function buildRepository(
		overrides: Partial<RepositoryConfig> = {},
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
			reviewOnStatus: "In Review",
			...overrides,
		} as RepositoryConfig;
	}

	function buildConfig(repo: RepositoryConfig): EdgeWorkerConfig {
		return {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repo],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
		} as EdgeWorkerConfig;
	}

	/** A delegation: Linear created the agent session before telling us. */
	function delegationWebhook(): any {
		return {
			type: "AgentSessionEvent",
			action: "created",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T18:00:00Z",
			agentSession: {
				id: "linear-session-1",
				issue: {
					id: "issue-1",
					identifier: "TEST-1",
					title: "Test Issue",
					description: "body",
				},
			},
		};
	}

	function createWorker(
		repo: RepositoryConfig,
		stateName: string,
		stateType = "started",
	) {
		const worker = new EdgeWorker(buildConfig(repo));
		(worker as any).agentSessionManager = mockAgentSessionManager;

		const tracker = {
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-1",
				identifier: "TEST-1",
				state: Promise.resolve({ name: stateName, type: stateType }),
			}),
			createAgentSessionOnIssue: vi.fn().mockResolvedValue({
				success: true,
				agentSession: Promise.resolve({ id: "minted-session" }),
			}),
		};
		(worker as any).issueTrackers = new Map([["test-workspace", tracker]]);

		// Routing + access control are not what this test is about.
		(worker as any).getCachedRepositories = vi.fn().mockReturnValue([repo]);
		(worker as any).checkUserAccess = vi
			.fn()
			.mockReturnValue({ allowed: true });
		(worker as any).activityPoster = {
			postThoughtActivity: vi.fn().mockResolvedValue(undefined),
		};
		// Short-circuit the builder path immediately after the review decision, so
		// "no review" is observable without running a real builder session.
		(worker as any).checkBlockedByDependencies = vi.fn().mockResolvedValue({
			blocked: true,
			blockingIssueIds: [],
			blockingIdentifiers: [],
		});

		const reviewRunner = vi
			.spyOn(worker as any, "initializeReviewRunner")
			.mockResolvedValue(undefined);

		return { worker, tracker, reviewRunner };
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

	describe("the flag is off by default", () => {
		it("does NOT review when reviewOnDelegateInStatus is unset, even in the review state", async () => {
			const { worker, reviewRunner } = createWorker(
				buildRepository(),
				"In Review",
			);

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[buildRepository()],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
		});

		it("does NOT review when explicitly false", async () => {
			const repo = buildRepository({ reviewOnDelegateInStatus: false } as any);
			const { worker, reviewRunner } = createWorker(repo, "In Review");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[repo],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
		});
	});

	describe("enabled", () => {
		const enabled = () =>
			buildRepository({ reviewOnDelegateInStatus: true } as any);

		it("reviews on the session Linear already created, minting nothing", async () => {
			const { worker, tracker, reviewRunner } = createWorker(
				enabled(),
				"In Review",
			);

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[enabled()],
			);

			expect(reviewRunner).toHaveBeenCalledTimes(1);
			// The delegated session id is used as-is — the whole point.
			expect(reviewRunner.mock.calls[0]?.[0]).toBe("linear-session-1");
			expect(reviewRunner.mock.calls[0]?.[1]).toMatchObject({
				issueId: "issue-1",
				issueIdentifier: "TEST-1",
				repositoryId: "test-repo",
				stateName: "In Review",
			});
			// No mint: that is what removes the mint/echo race.
			expect(tracker.createAgentSessionOnIssue).not.toHaveBeenCalled();
		});

		it("matches the state name case-insensitively", async () => {
			const repo = buildRepository({
				reviewOnStatus: "in review",
				reviewOnDelegateInStatus: true,
			} as any);
			const { worker, reviewRunner } = createWorker(repo, "In Review");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[repo],
			);

			expect(reviewRunner).toHaveBeenCalledTimes(1);
		});

		it("marks the session as a review so a duplicate echo is dropped", async () => {
			const { worker } = createWorker(enabled(), "In Review");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[enabled()],
			);

			expect(
				(worker as any).reviewSessions.isReviewSession("linear-session-1"),
			).toBe(true);
		});

		it("does NOT review when the issue is in some other state", async () => {
			const { worker, reviewRunner } = createWorker(enabled(), "In Progress");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[enabled()],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
		});

		it("does NOT review when reviewOnStatus is unset — the flag needs a state to name", async () => {
			const repo = buildRepository({
				reviewOnStatus: undefined,
				reviewOnDelegateInStatus: true,
			} as any);
			const { worker, reviewRunner } = createWorker(repo, "In Review");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[repo],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
		});

		it("does NOT review in a terminal state that happens to match", async () => {
			// Terminal states tear down the issue's sessions and worktrees, so a
			// review started there would race its own cleanup.
			const repo = buildRepository({
				reviewOnStatus: "Done",
				reviewOnDelegateInStatus: true,
			} as any);
			const { worker, reviewRunner } = createWorker(repo, "Done", "completed");
			const warn = vi.spyOn((worker as any).logger, "warn");

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[repo],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalled();
		});

		it("falls through to a normal session when the state cannot be resolved", async () => {
			const { worker, tracker, reviewRunner } = createWorker(
				enabled(),
				"In Review",
			);
			tracker.fetchIssue.mockRejectedValue(new Error("Linear unavailable"));

			await (worker as any).handleAgentSessionCreatedWebhook(
				delegationWebhook(),
				[enabled()],
			);

			expect(reviewRunner).not.toHaveBeenCalled();
		});
	});
});
