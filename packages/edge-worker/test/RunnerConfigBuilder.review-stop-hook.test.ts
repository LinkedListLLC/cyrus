import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	inspectGitGuardrail,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

/**
 * CYR-16 / B3 — the "ship your work before stopping" Stop guardrail must not be
 * installed on a `reviewOnStatus` review.
 *
 * A review runs in a **detached** worktree at the PR head. `git status` there is
 * clean, but `@{u}` does not resolve on a detached HEAD, so the guardrail falls
 * back to `origin/HEAD` and counts the pull request's *own* commits as
 * "not yet on the remote". It then blocks the stop and instructs a read-only
 * reviewer to commit, push, and open a pull request — the exact inversion of
 * what the session exists to do, and something it has no tools to comply with.
 */

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, args: string): string {
	return execSync(`git ${args}`, {
		cwd,
		env: GIT_ENV,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function buildIssueConfig(readOnlySession: boolean | undefined) {
	const session = {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/review", isGitWorktree: true },
	} as unknown as CyrusAgentSession;

	return makeBuilder().buildIssueConfig({
		session,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "review",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/ws/review"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(readOnlySession === undefined ? {} : { readOnlySession }),
	});
}

describe("Stop guardrail on a detached review worktree (CYR-16 / B3)", () => {
	let tmpRoot: string;
	let repoPath: string;
	let reviewPath: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-review-stop-hook-"));

		// A bare "remote" with main plus a feature branch (the PR head), cloned
		// so that `origin/HEAD` is set exactly as it is in a real Cyrus repo.
		const originPath = join(tmpRoot, "origin.git");
		mkdirSync(originPath, { recursive: true });
		git(tmpRoot, `init --bare --initial-branch=main "${originPath}"`);

		const seedPath = join(tmpRoot, "seed");
		mkdirSync(seedPath, { recursive: true });
		git(tmpRoot, `init --initial-branch=main "${seedPath}"`);
		writeFileSync(join(seedPath, "app.ts"), "export const answer = 41;\n");
		git(seedPath, "add .");
		git(seedPath, 'commit -m "base"');
		git(seedPath, `remote add origin "${originPath}"`);
		git(seedPath, "push -u origin main");

		git(seedPath, "checkout -b feature-x");
		writeFileSync(join(seedPath, "app.ts"), "export const answer = 42;\n");
		git(seedPath, "add .");
		git(seedPath, 'commit -m "the change under review"');
		git(seedPath, "push -u origin feature-x");

		repoPath = join(tmpRoot, "repo");
		git(tmpRoot, `clone "${originPath}" "${repoPath}"`);

		// Exactly what GitService.createReviewWorktree produces.
		reviewPath = join(tmpRoot, "review");
		git(repoPath, `worktree add --detach "${reviewPath}" origin/feature-x`);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("would block the review and order it to commit and push", () => {
		// Sanity: the review checkout is clean and detached, as designed.
		expect(git(reviewPath, "status --porcelain")).toBe("");
		expect(git(reviewPath, "rev-parse --abbrev-ref HEAD")).toBe("HEAD");

		const guardrail = inspectGitGuardrail(reviewPath, silentLogger);

		// This is the bug: a read-only reviewer is told to ship the PR's commits.
		expect(guardrail).not.toBeNull();
		expect(guardrail).toMatch(/commits? not yet on the remote/);
		expect(guardrail).toContain("Push the branch to the remote");
		expect(guardrail).toContain("Create or update a pull request");
	});

	it("omits the Stop hook entirely for a read-only session", () => {
		const { config } = buildIssueConfig(true);

		expect(config.hooks?.Stop).toBeUndefined();
	});

	it("still installs the Stop hook for a normal builder session", () => {
		const { config } = buildIssueConfig(false);

		expect(config.hooks?.Stop).toHaveLength(1);
	});

	it("defaults to installing the Stop hook when the flag is absent", () => {
		const { config } = buildIssueConfig(undefined);

		expect(config.hooks?.Stop).toHaveLength(1);
	});
});
