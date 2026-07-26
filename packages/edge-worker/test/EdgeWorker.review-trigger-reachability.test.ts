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
 * CYR-33: which webhook types can actually reach the `reviewOnStatus` review.
 *
 * Every other reviewOnStatus test calls `handleIssueStateChange` directly, so the
 * whole suite verifies the feature *from the handler inward*. The defect was
 * outside the handler: `maybeStartStatusReview` has one call site, reached from
 * one router branch, which requires an `Issue`/`update` webhook — and the Linear
 * app was not subscribed to `Issue` webhooks, so the branch could never be taken.
 * A correct implementation shipped behind an unreachable trigger and 850+ tests
 * had nothing to say about it.
 *
 * These tests drive the real router (`handleWebhook`) instead, so the reachable
 * set is a pinned property rather than an assumption.
 */
describe("EdgeWorker - reviewOnStatus trigger reachability (CYR-33)", () => {
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
			reviewOnStatus: "In Review",
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

	/**
	 * The exact `type`/`action` pairs the production container received in the
	 * CYR-33 capture window, plus the entity webhook it never received.
	 */
	const WEBHOOKS: Record<string, () => any> = {
		"Issue/update (stateId changed)": () => ({
			type: "Issue",
			action: "update",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:47:49Z",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-in-review",
			},
			updatedFrom: { stateId: "state-in-progress" },
		}),
		"Issue/update (title changed)": () => ({
			type: "Issue",
			action: "update",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:47:49Z",
			data: { id: "issue-1", identifier: "TEST-1", title: "Renamed" },
			updatedFrom: { title: "Test Issue" },
		}),
		"Issue/remove": () => ({
			type: "Issue",
			action: "remove",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:47:49Z",
			data: { id: "issue-1", identifier: "TEST-1" },
		}),
		"AppUserNotification/issueStatusChanged": () => ({
			type: "AppUserNotification",
			action: "issueStatusChanged",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:14:44Z",
			notification: {
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
		}),
		"AppUserNotification/issueAssignedToYou": () => ({
			type: "AppUserNotification",
			action: "issueAssignedToYou",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:14:17Z",
			notification: {
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
		}),
		"AppUserNotification/issueSubscribed": () => ({
			type: "AppUserNotification",
			action: "issueSubscribed",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:14:17Z",
			notification: {
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
		}),
		"AppUserNotification/issueNewComment": () => ({
			type: "AppUserNotification",
			action: "issueNewComment",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:19:35Z",
			notification: {
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
		}),
		"AgentSessionEvent/created": () => ({
			type: "AgentSessionEvent",
			action: "created",
			organizationId: "test-workspace",
			createdAt: "2026-07-26T17:14:17Z",
			agentSession: {
				id: "session-1",
				issue: { id: "issue-1", identifier: "TEST-1", title: "Test Issue" },
			},
		}),
	};

	/** Only this one may ever start a review. */
	const REACHING = "Issue/update (stateId changed)";

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
					createAgentSessionOnIssue: vi.fn().mockResolvedValue({
						success: true,
						agentSession: Promise.resolve({ id: "review-session-1" }),
					}),
				},
			],
		]);

		(worker as any).resolveRepositoryForIssue = vi
			.fn()
			.mockReturnValue(buildRepository());

		// Stub the sibling handlers so this test measures routing only — an
		// unrelated handler throwing must not be mistaken for "did not reach".
		(worker as any).handleAgentSessionCreatedWebhook = vi
			.fn()
			.mockResolvedValue(undefined);
		(worker as any).handleUserPromptedAgentActivity = vi
			.fn()
			.mockResolvedValue(undefined);
		(worker as any).handleIssueContentUpdate = vi
			.fn()
			.mockResolvedValue(undefined);
		(worker as any).handleIssueUnassignedWebhook = vi
			.fn()
			.mockResolvedValue(undefined);

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

	describe("the reachable set is exactly one webhook shape", () => {
		for (const [label, build] of Object.entries(WEBHOOKS)) {
			const shouldReach = label === REACHING;

			it(`${shouldReach ? "reaches" : "does NOT reach"} the review: ${label}`, async () => {
				const worker = createWorker();
				const review = vi
					.spyOn(worker as any, "maybeStartStatusReview")
					.mockResolvedValue(undefined);

				await (worker as any).handleWebhook(build(), [buildRepository()]);

				expect(review).toHaveBeenCalledTimes(shouldReach ? 1 : 0);
			});
		}
	});

	it("routes issueStatusChanged to the terminal message-bus path, never to a review", async () => {
		// The production misreading of CYR-33 was that this notification could be
		// re-used as the review trigger. It cannot: it is the entry point to the
		// unconditionally-terminal path that stops sessions and deletes worktrees.
		const worker = createWorker();
		const review = vi
			.spyOn(worker as any, "maybeStartStatusReview")
			.mockResolvedValue(undefined);
		const stateChange = vi
			.spyOn(worker as any, "handleIssueStateChange")
			.mockResolvedValue(undefined);

		await (worker as any).handleWebhook(
			WEBHOOKS["AppUserNotification/issueStatusChanged"](),
			[buildRepository()],
		);

		expect(stateChange).not.toHaveBeenCalled();
		expect(review).not.toHaveBeenCalled();
	});

	it("starts a review end-to-end through the router, not just the handler", async () => {
		const worker = createWorker();
		const tracker = (worker as any).issueTrackers.get("test-workspace");

		await (worker as any).handleWebhook(WEBHOOKS[REACHING](), [
			buildRepository(),
		]);

		expect(tracker.createAgentSessionOnIssue).toHaveBeenCalledWith({
			issueId: "issue-1",
		});
	});

	describe("unreachable-trigger diagnostic", () => {
		it("warns when a status notification arrives but no Issue webhook ever has", async () => {
			const worker = createWorker();
			const warn = vi.spyOn((worker as any).logger, "warn");

			await (worker as any).handleWebhook(
				WEBHOOKS["AppUserNotification/issueStatusChanged"](),
				[buildRepository()],
			);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("Test Repo");
			expect(warn.mock.calls[0]?.[0]).toContain("Issue");
		});

		it("warns only once, however many notifications arrive", async () => {
			const worker = createWorker();
			const warn = vi.spyOn((worker as any).logger, "warn");

			for (let i = 0; i < 3; i++) {
				await (worker as any).handleWebhook(
					WEBHOOKS["AppUserNotification/issueStatusChanged"](),
					[buildRepository()],
				);
			}

			expect(warn).toHaveBeenCalledTimes(1);
		});

		it("stays silent once an Issue webhook proves the channel is live", async () => {
			const worker = createWorker();
			const warn = vi.spyOn((worker as any).logger, "warn");

			await (worker as any).handleWebhook(WEBHOOKS[REACHING](), [
				buildRepository(),
			]);
			await (worker as any).handleWebhook(
				WEBHOOKS["AppUserNotification/issueStatusChanged"](),
				[buildRepository()],
			);

			expect(warn).not.toHaveBeenCalled();
		});

		it("stays silent when no repository opted into reviewOnStatus", async () => {
			const worker = new EdgeWorker({
				...buildConfig(),
				repositories: [{ ...buildRepository(), reviewOnStatus: undefined }],
			} as EdgeWorkerConfig);
			(worker as any).agentSessionManager = mockAgentSessionManager;
			const warn = vi.spyOn((worker as any).logger, "warn");

			await (worker as any).handleWebhook(
				WEBHOOKS["AppUserNotification/issueStatusChanged"](),
				[],
			);

			expect(warn).not.toHaveBeenCalled();
		});
	});
});
