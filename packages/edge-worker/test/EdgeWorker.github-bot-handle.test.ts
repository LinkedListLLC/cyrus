import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * The handle a pull request tells reviewers to @mention must belong to the
 * GitHub App this instance runs as. It differs for every deployment, so it is
 * read from the deployment instead of hardcoded.
 */
describe("EdgeWorker - GitHub bot handle", () => {
	const savedEnv = {
		botUsername: process.env.GITHUB_BOT_USERNAME,
		appSlug: process.env.GITHUB_APP_SLUG,
		gitlabBotUsername: process.env.GITLAB_BOT_USERNAME,
	};

	beforeEach(() => {
		delete process.env.GITHUB_BOT_USERNAME;
		delete process.env.GITHUB_APP_SLUG;
		delete process.env.GITLAB_BOT_USERNAME;
	});

	afterEach(() => {
		restore("GITHUB_BOT_USERNAME", savedEnv.botUsername);
		restore("GITHUB_APP_SLUG", savedEnv.appSlug);
		restore("GITLAB_BOT_USERNAME", savedEnv.gitlabBotUsername);
	});

	function restore(name: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	it("prefers the operator override over every other source", () => {
		process.env.GITHUB_BOT_USERNAME = "cyrus-william";
		process.env.GITHUB_APP_SLUG = "some-other-slug";

		const worker = createTestWorker() as any;
		worker.gitHubAppSlug = "a-third-slug";

		expect(worker.getGitHubBotUsername()).toBe("cyrus-william");
	});

	it("falls back to the App slug in the environment", () => {
		process.env.GITHUB_APP_SLUG = "cyrus-william";

		const worker = createTestWorker() as any;

		expect(worker.getGitHubBotUsername()).toBe("cyrus-william");
	});

	it("reads the App slug from GitHub when the environment names no handle", async () => {
		const worker = createTestWorker() as any;
		const getAppSlug = vi.fn().mockResolvedValue("cyrus-william");
		worker.gitHubAppTokenProvider = { getAppSlug };

		worker.resolveGitHubBotUsername();
		await vi.waitFor(() =>
			expect(worker.getGitHubBotUsername()).toBe("cyrus-william"),
		);
		expect(getAppSlug).toHaveBeenCalledOnce();
	});

	it("keeps no handle when the App slug cannot be read", async () => {
		const worker = createTestWorker() as any;
		const getAppSlug = vi.fn().mockRejectedValue(new Error("401"));
		worker.gitHubAppTokenProvider = { getAppSlug };

		worker.resolveGitHubBotUsername();
		await vi.waitFor(() => expect(getAppSlug).toHaveBeenCalledOnce());

		expect(worker.getGitHubBotUsername()).toBe("");
		expect(worker.buildAgentContextBlock()).toBe("");
	});

	it("does not call GitHub when the environment already names a handle", () => {
		process.env.GITHUB_BOT_USERNAME = "cyrus-william";

		const worker = createTestWorker() as any;
		const getAppSlug = vi.fn();
		worker.gitHubAppTokenProvider = { getAppSlug };

		worker.resolveGitHubBotUsername();

		expect(getAppSlug).not.toHaveBeenCalled();
	});

	it("puts the resolved handle in the agent context block", () => {
		process.env.GITHUB_APP_SLUG = "cyrus-william";

		const worker = createTestWorker() as any;

		expect(worker.buildAgentContextBlock()).toBe(
			`\n\n<agent_context>
  <github_bot_username>cyrus-william</github_bot_username>
</agent_context>`,
		);
	});

	describe("self-comment skip", () => {
		function createCommentEvent(author: string): any {
			return {
				eventType: "issue_comment",
				deliveryId: "delivery-001",
				payload: {
					action: "created",
					issue: {
						number: 42,
						title: "Fix failing tests",
						pull_request: { url: "https://api.github.com/pulls/42" },
					},
					comment: {
						id: 999,
						body: "Please take another look",
						user: { login: author },
					},
					repository: {
						full_name: "testorg/my-repo",
						name: "my-repo",
						owner: { login: "testorg" },
					},
					sender: { login: author },
				},
			};
		}

		it("ignores a comment written by the App under its [bot] login", async () => {
			process.env.GITHUB_APP_SLUG = "cyrus-william";

			const worker = createTestWorker() as any;
			worker.resolveGitHubToken = vi.fn().mockResolvedValue("ghs_token");

			await worker.handleGitHubWebhook(
				createCommentEvent("cyrus-william[bot]"),
			);

			expect(worker.resolveGitHubToken).not.toHaveBeenCalled();
		});

		it("ignores a comment written by the bot user account", async () => {
			process.env.GITHUB_APP_SLUG = "cyrus-william";

			const worker = createTestWorker() as any;
			worker.resolveGitHubToken = vi.fn().mockResolvedValue("ghs_token");

			await worker.handleGitHubWebhook(createCommentEvent("cyrus-william"));

			expect(worker.resolveGitHubToken).not.toHaveBeenCalled();
		});

		it("still handles a comment written by a person", async () => {
			process.env.GITHUB_APP_SLUG = "cyrus-william";

			const worker = createTestWorker() as any;
			worker.resolveGitHubToken = vi.fn().mockResolvedValue("ghs_token");
			worker.findRepositoryByGitHubUrl = vi.fn().mockReturnValue(undefined);

			await worker.handleGitHubWebhook(createCommentEvent("a-reviewer"));

			expect(worker.resolveGitHubToken).toHaveBeenCalled();
		});
	});

	it("keeps the GitLab handle alongside the GitHub one", () => {
		process.env.GITHUB_APP_SLUG = "cyrus-william";
		process.env.GITLAB_BOT_USERNAME = "cyrus-gitlab";

		const worker = createTestWorker() as any;

		expect(worker.buildAgentContextBlock()).toBe(
			`\n\n<agent_context>
  <github_bot_username>cyrus-william</github_bot_username>
  <gitlab_bot_username>cyrus-gitlab</gitlab_bot_username>
</agent_context>`,
		);
	});
});
