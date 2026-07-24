import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";

/**
 * Real-git tests for the `reviewOnStatus` review worktree.
 *
 * The whole point of the review worktree is that it is a *clean* checkout of
 * the PR head rather than the builder's working tree, so these run against
 * actual git repositories — a mocked `execSync` would assert our command
 * strings back at us and prove nothing about the checkout.
 */

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	event: () => {},
	withContext: () => silentLogger,
	getLevel: () => "info" as never,
	setLevel: () => {},
};

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(command: string, cwd: string): string {
	return execSync(`git ${command}`, {
		cwd,
		env: GIT_ENV,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

describe("GitService.createReviewWorktree", () => {
	let tmpRoot: string;
	let originPath: string;
	let repoPath: string;
	let repository: RepositoryConfig;
	let gitService: GitService;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "cyrus-review-worktree-"));

		// A "remote" with main plus a feature branch (the PR head).
		originPath = join(tmpRoot, "origin");
		mkdirSync(originPath, { recursive: true });
		git("init --initial-branch=main", originPath);
		writeFileSync(join(originPath, "app.ts"), "export const answer = 41;\n");
		git("add .", originPath);
		git('commit -m "base"', originPath);

		git("checkout -b feature-x", originPath);
		writeFileSync(join(originPath, "app.ts"), "export const answer = 42;\n");
		git("add .", originPath);
		git('commit -m "the change under review"', originPath);
		git("checkout main", originPath);

		repoPath = join(tmpRoot, "repo");
		git(`clone "${originPath}" "${repoPath}"`, tmpRoot);

		repository = {
			id: "repo-1",
			name: "repo",
			repositoryPath: repoPath,
			baseBranch: "main",
			workspaceBaseDir: join(tmpRoot, "workspaces"),
		} as RepositoryConfig;

		gitService = new GitService({ cyrusHome: tmpRoot }, silentLogger);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("checks out the PR head in a detached worktree", async () => {
		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		expect(existsSync(worktree.path)).toBe(true);
		expect(worktree.checkoutRef).toBe("origin/feature-x");
		expect(worktree.usedFallbackRef).toBe(false);

		// Detached: no branch is checked out, so the builder can keep working.
		expect(git("rev-parse --abbrev-ref HEAD", worktree.path)).toBe("HEAD");
		// And it is the PR head's content, not main's.
		expect(git("rev-parse HEAD", worktree.path)).toBe(
			git("rev-parse origin/feature-x", repoPath),
		);
	});

	it("reviews the pushed head, not the builder's dirty worktree", async () => {
		// The builder is mid-edit on the same branch.
		const builderPath = join(tmpRoot, "workspaces", "TEST-1");
		mkdirSync(join(tmpRoot, "workspaces"), { recursive: true });
		git(`worktree add "${builderPath}" feature-x`, repoPath);
		writeFileSync(join(builderPath, "app.ts"), "export const answer = 999;\n");

		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		expect(worktree.path).not.toBe(builderPath);
		expect(git("status --porcelain", worktree.path)).toBe("");
		// The builder's uncommitted 999 is not what gets reviewed.
		expect(git("show HEAD:app.ts", worktree.path)).toContain("42");
	});

	it("puts the review outside the issue-keyed workspace directory", async () => {
		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		expect(worktree.path).toContain(join("workspaces", "reviews"));
		expect(worktree.path).not.toBe(join(tmpRoot, "workspaces", "TEST-1"));
	});

	it("gives concurrent reviews of one issue separate worktrees", async () => {
		const first = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-aaaaaaaa1111",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});
		const second = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-bbbbbbbb2222",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		expect(first.path).not.toBe(second.path);
		expect(existsSync(first.path)).toBe(true);
		expect(existsSync(second.path)).toBe(true);
	});

	it("falls back to the base branch and says so when the branch is missing", async () => {
		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "no-such-branch",
		});

		expect(worktree.checkoutRef).toBe("origin/main");
		expect(worktree.usedFallbackRef).toBe(true);
	});

	it("rejects a repository path that is not a git repository", async () => {
		const notARepo = join(tmpRoot, "not-a-repo");
		mkdirSync(notARepo, { recursive: true });

		await expect(
			gitService.createReviewWorktree({
				repository: { ...repository, repositoryPath: notARepo },
				reviewId: "session-abcdef123456",
				issueIdentifier: "TEST-1",
				branchName: "feature-x",
			}),
		).rejects.toThrow(/not a git repository/);
	});

	it("removes the worktree and leaves no stale git entry", async () => {
		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		gitService.removeReviewWorktree(worktree);

		expect(existsSync(worktree.path)).toBe(false);
		expect(git("worktree list --porcelain", repoPath)).not.toContain(
			worktree.path,
		);
	});

	it("recreates cleanly after a leftover directory from a crashed review", async () => {
		const worktree = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});
		writeFileSync(join(worktree.path, "scratch.txt"), "left behind\n");

		const retried = await gitService.createReviewWorktree({
			repository,
			reviewId: "session-abcdef123456",
			issueIdentifier: "TEST-1",
			branchName: "feature-x",
		});

		expect(retried.path).toBe(worktree.path);
		expect(existsSync(join(retried.path, "scratch.txt"))).toBe(false);
		expect(git("status --porcelain", retried.path)).toBe("");
	});
});
