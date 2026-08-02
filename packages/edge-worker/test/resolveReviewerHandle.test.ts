import type { ReviewerMapping } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { resolveReviewerHandle } from "../src/UserAccessControl.js";

/**
 * Tests for the reviewer lookup that turns the delegating Linear user into the
 * GitHub handle requested on the pull request.
 *
 * It reuses `userMatchesIdentifier`, the same matcher the allowlist and the
 * blocklist use, so these tests concentrate on what is new: the handle, and the
 * outcome for a user who is not in the map.
 */

const REVIEWERS: ReviewerMapping[] = [
	{ email: "rayan@example.com", github: "rayan-gh" },
	{ id: "usr_william", github: "whollacsek" },
];

describe("resolveReviewerHandle", () => {
	it("finds the handle by email", () => {
		expect(
			resolveReviewerHandle(undefined, "rayan@example.com", REVIEWERS),
		).toBe("rayan-gh");
	});

	it("finds the handle by Linear ID", () => {
		expect(resolveReviewerHandle("usr_william", undefined, REVIEWERS)).toBe(
			"whollacsek",
		);
	});

	it("matches an email whatever the letter case, as the allowlist does", () => {
		expect(
			resolveReviewerHandle(undefined, "Rayan@Example.COM", REVIEWERS),
		).toBe("rayan-gh");
	});

	it("prefers the first matching entry", () => {
		const reviewers: ReviewerMapping[] = [
			{ email: "rayan@example.com", github: "first" },
			{ email: "rayan@example.com", github: "second" },
		];
		expect(
			resolveReviewerHandle(undefined, "rayan@example.com", reviewers),
		).toBe("first");
	});

	// An unmapped user must never stop the session — the pull request simply
	// opens with no reviewer.
	it("returns undefined for a user who is not in the map", () => {
		expect(
			resolveReviewerHandle("usr_other", "other@example.com", REVIEWERS),
		).toBeUndefined();
	});

	it("returns undefined when no map is configured", () => {
		expect(
			resolveReviewerHandle("usr_william", undefined, undefined),
		).toBeUndefined();
		expect(resolveReviewerHandle("usr_william", undefined, [])).toBeUndefined();
	});

	it("returns undefined when the user has neither an ID nor an email", () => {
		expect(
			resolveReviewerHandle(undefined, undefined, REVIEWERS),
		).toBeUndefined();
	});

	it("treats a blank handle as no entry", () => {
		expect(
			resolveReviewerHandle(undefined, "blank@example.com", [
				{ email: "blank@example.com", github: "   " },
			]),
		).toBeUndefined();
	});

	it("trims a handle that has stray whitespace", () => {
		expect(
			resolveReviewerHandle(undefined, "rayan@example.com", [
				{ email: "rayan@example.com", github: " rayan-gh " },
			]),
		).toBe("rayan-gh");
	});
});
