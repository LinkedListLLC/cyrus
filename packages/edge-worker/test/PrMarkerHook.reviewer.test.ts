import { execFileSync, spawnSync } from "node:child_process";
import type { ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPrMarkerProvider } from "../src/hooks/PrMarkerHook.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	spawnSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);
const spawnSyncMock = vi.mocked(spawnSync);

function makeLogger(): ILogger & {
	warn: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
} {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as ILogger & {
		warn: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
	};
}

/** Make `gh pr view` return this payload. */
function givenPr(payload: Record<string, unknown>): void {
	execFileSyncMock.mockReturnValue(JSON.stringify(payload) as never);
}

/** Every `gh pr edit` call the provider made. */
function editCalls(): string[][] {
	return spawnSyncMock.mock.calls.map((call) => call[1] as string[]);
}

/** The `gh pr edit ... --add-reviewer` call, if there was one. */
function reviewerCall(): string[] | undefined {
	return editCalls().find((args) => args.includes("--add-reviewer"));
}

const MARKED_BODY = "summary\n\n<!-- generated-by-cyrus -->";

beforeEach(() => {
	vi.clearAllMocks();
	spawnSyncMock.mockReturnValue({ status: 0, stderr: "" } as never);
});

describe("GitHubPrMarkerProvider — reviewer requests", () => {
	it("requests the reviewer on the pull request", () => {
		givenPr({ number: 42, body: MARKED_BODY, author: { login: "cyrus[bot]" } });
		const log = makeLogger();

		new GitHubPrMarkerProvider().ensureMarker("/repo", log, {
			reviewer: "rayan-gh",
		});

		expect(reviewerCall()).toEqual([
			"pr",
			"edit",
			"42",
			"--add-reviewer",
			"rayan-gh",
		]);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("Requested @rayan-gh"),
		);
	});

	it("asks gh for the author and the existing review requests", () => {
		givenPr({ number: 42, body: MARKED_BODY });

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {
			reviewer: "rayan-gh",
		});

		expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual([
			"pr",
			"view",
			"--json",
			"body,number,author,reviewRequests",
		]);
	});

	it("does nothing when no reviewer is configured", () => {
		givenPr({ number: 42, body: MARKED_BODY, author: { login: "cyrus[bot]" } });

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {});

		expect(reviewerCall()).toBeUndefined();
	});

	it("does nothing when no context is passed at all", () => {
		givenPr({ number: 42, body: MARKED_BODY });

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger());

		expect(reviewerCall()).toBeUndefined();
	});

	// The hook fires on every `gh pr create` AND every `gh pr edit`, including
	// the edit it makes itself, so it runs more than once per pull request.
	it("is idempotent: skips a reviewer who is already requested", () => {
		givenPr({
			number: 42,
			body: MARKED_BODY,
			author: { login: "cyrus[bot]" },
			reviewRequests: [{ login: "rayan-gh" }],
		});
		const log = makeLogger();

		new GitHubPrMarkerProvider().ensureMarker("/repo", log, {
			reviewer: "rayan-gh",
		});

		expect(reviewerCall()).toBeUndefined();
		expect(log.debug).toHaveBeenCalledWith(
			expect.stringContaining("already requested"),
		);
	});

	it("matches an existing request whatever the letter case", () => {
		givenPr({
			number: 42,
			body: MARKED_BODY,
			reviewRequests: [{ login: "Rayan-GH" }],
		});

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {
			reviewer: "rayan-gh",
		});

		expect(reviewerCall()).toBeUndefined();
	});

	it("never requests the author, so the bot is never asked to review itself", () => {
		givenPr({ number: 42, body: MARKED_BODY, author: { login: "cyrus[bot]" } });
		const log = makeLogger();

		new GitHubPrMarkerProvider().ensureMarker("/repo", log, {
			reviewer: "cyrus[bot]",
		});

		expect(reviewerCall()).toBeUndefined();
		expect(log.debug).toHaveBeenCalledWith(
			expect.stringContaining("they are the author"),
		);
	});

	it("ignores team review requests, which carry no login", () => {
		givenPr({
			number: 42,
			body: MARKED_BODY,
			reviewRequests: [{ slug: "reviewers" }],
		});

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {
			reviewer: "rayan-gh",
		});

		expect(reviewerCall()).toBeDefined();
	});

	it("warns and continues when gh rejects the reviewer", () => {
		givenPr({ number: 42, body: MARKED_BODY });
		spawnSyncMock.mockReturnValue({
			status: 1,
			stderr: "could not add reviewer: user not found",
		} as never);
		const log = makeLogger();

		expect(() =>
			new GitHubPrMarkerProvider().ensureMarker("/repo", log, {
				reviewer: "not-a-user",
			}),
		).not.toThrow();

		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("Could not request @not-a-user"),
		);
	});

	it("requests the reviewer even when the marker write fails", () => {
		givenPr({ number: 42, body: "summary with no marker" });
		spawnSyncMock
			.mockReturnValueOnce({ status: 1, stderr: "body rejected" } as never)
			.mockReturnValue({ status: 0, stderr: "" } as never);

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {
			reviewer: "rayan-gh",
		});

		expect(reviewerCall()).toBeDefined();
	});

	it("does nothing when the branch has no pull request", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("no pull requests found");
		});

		new GitHubPrMarkerProvider().ensureMarker("/repo", makeLogger(), {
			reviewer: "rayan-gh",
		});

		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});
