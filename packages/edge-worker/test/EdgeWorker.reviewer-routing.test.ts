import type {
	CyrusAgentSession,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock the same dependency set the other EdgeWorker unit tests mock, so that
// constructing a worker touches no network, filesystem or child process.
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
 * Tests for reviewer routing: the person who delegates a Linear issue is
 * requested as reviewer on the pull request Cyrus opens.
 *
 * A pull request that a bot opens can be approved by anybody on the team, but
 * it notifies nobody. Only a requested review produces a notification, so this
 * step is what actually reaches the delegating user.
 */
describe("EdgeWorker — reviewer routing", () => {
	function makeRepository(
		reviewers: RepositoryConfig["reviewers"],
	): RepositoryConfig {
		return {
			id: "test-repo",
			name: "Test Repo",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspaces",
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
			reviewers,
		} as RepositoryConfig;
	}

	function makeWorker(repository: RepositoryConfig): EdgeWorker {
		return new EdgeWorker({
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as EdgeWorkerConfig);
	}

	function makeSession(): CyrusAgentSession {
		return { id: "session-1" } as CyrusAgentSession;
	}

	let log: ILogger & {
		info: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as typeof log;
	});

	function stamp(
		repository: RepositoryConfig,
		creator: { id?: string; email?: string; name?: string } | undefined,
	): CyrusAgentSession {
		const worker = makeWorker(repository);
		const session = makeSession();
		(worker as any).stampReviewerHandle(session, creator, repository, log);
		return session;
	}

	it("records the delegating user's GitHub handle on the session", () => {
		const repository = makeRepository([
			{ email: "rayan@example.com", github: "rayan-gh" },
		]);

		const session = stamp(repository, {
			id: "usr_rayan",
			email: "rayan@example.com",
			name: "Rayan",
		});

		expect(session.metadata?.reviewerGithubHandle).toBe("rayan-gh");
	});

	it("matches by Linear ID as well as by email", () => {
		const repository = makeRepository([
			{ id: "usr_william", github: "whollacsek" },
		]);

		const session = stamp(repository, { id: "usr_william", name: "William" });

		expect(session.metadata?.reviewerGithubHandle).toBe("whollacsek");
	});

	it("keeps the rest of the session metadata", () => {
		const repository = makeRepository([
			{ email: "rayan@example.com", github: "rayan-gh" },
		]);
		const worker = makeWorker(repository);
		const session = {
			id: "session-1",
			metadata: { readOnlyReview: true },
		} as CyrusAgentSession;

		(worker as any).stampReviewerHandle(
			session,
			{ email: "rayan@example.com" },
			repository,
			log,
		);

		expect(session.metadata?.readOnlyReview).toBe(true);
		expect(session.metadata?.reviewerGithubHandle).toBe("rayan-gh");
	});

	// The session must continue. A missing mapping costs a notification, and
	// nothing else.
	it("logs and continues when the delegating user has no mapping", () => {
		const repository = makeRepository([
			{ email: "rayan@example.com", github: "rayan-gh" },
		]);

		const session = stamp(repository, {
			id: "usr_stranger",
			email: "stranger@example.com",
			name: "Stranger",
		});

		expect(session.metadata?.reviewerGithubHandle).toBeUndefined();
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining(
				"Stranger is not in this repository's reviewers map",
			),
		);
		// The inputs travel with the outcome, so a live log says why.
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("reviewers=1"),
		);
	});

	// This case previously asserted `log.info` was NOT called. That silence was
	// specified, not accidental — and it is what made the feature fail invisibly
	// in production: a repository whose map never reached memory looked exactly
	// like one where routing succeeded. Reversed deliberately.
	it("says routing is off when the repository configures no reviewers at all", () => {
		const session = stamp(makeRepository(undefined), {
			id: "usr_rayan",
			email: "rayan@example.com",
		});

		expect(session.metadata?.reviewerGithubHandle).toBeUndefined();
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("no reviewers map, so routing is off"),
		);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("reviewers=0"),
		);
	});

	it("tolerates a webhook with no creator, and says the creator was missing", () => {
		const repository = makeRepository([
			{ email: "rayan@example.com", github: "rayan-gh" },
		]);

		expect(() => stamp(repository, undefined)).not.toThrow();
		// Distinguishes "the map is wrong" from "the webhook carried nobody" —
		// two failures that were previously indistinguishable in the log.
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("creator.id=no creator.email=no"),
		);
	});

	it("reports a successful match too, so success is visible not assumed", () => {
		const repository = makeRepository([
			{ email: "rayan@example.com", github: "rayan-gh" },
		]);

		stamp(repository, { id: "usr_rayan", email: "rayan@example.com" });

		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("Will request @rayan-gh as reviewer"),
		);
	});
});
