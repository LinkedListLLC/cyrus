import { describe, expect, it } from "vitest";
import {
	matchesReviewStatus,
	type ReviewSessionContext,
	ReviewSessionTracker,
} from "../src/ReviewSessionTracker.js";

function makeContext(
	overrides: Partial<ReviewSessionContext> = {},
): ReviewSessionContext {
	return {
		issueId: "issue-1",
		issueIdentifier: "CYR-5",
		repositoryId: "repo-1",
		linearWorkspaceId: "org-1",
		stateName: "In Review",
		...overrides,
	};
}

describe("matchesReviewStatus", () => {
	it("matches the configured state name exactly", () => {
		expect(matchesReviewStatus("In Review", "In Review")).toBe(true);
	});

	it("matches case-insensitively and ignores surrounding whitespace", () => {
		expect(matchesReviewStatus("in review", "In Review")).toBe(true);
		expect(matchesReviewStatus("In Review ", " in REVIEW")).toBe(true);
	});

	it("does not match a different state", () => {
		expect(matchesReviewStatus("In Review", "In Progress")).toBe(false);
		expect(matchesReviewStatus("In Review", "Done")).toBe(false);
	});

	it("is disabled when unconfigured, empty, or whitespace-only", () => {
		expect(matchesReviewStatus(undefined, "In Review")).toBe(false);
		expect(matchesReviewStatus("", "In Review")).toBe(false);
		expect(matchesReviewStatus("   ", "In Review")).toBe(false);
		expect(matchesReviewStatus(null, "In Review")).toBe(false);
	});

	it("does not match when the state name is missing", () => {
		expect(matchesReviewStatus("In Review", undefined)).toBe(false);
		expect(matchesReviewStatus("In Review", "")).toBe(false);
	});
});

describe("ReviewSessionTracker - webhook de-duplication", () => {
	it("accepts a key once and rejects replays", () => {
		const tracker = new ReviewSessionTracker();

		expect(tracker.markWebhookProcessed("2025-01-01T00:00:00Z:issue-1")).toBe(
			true,
		);
		expect(tracker.markWebhookProcessed("2025-01-01T00:00:00Z:issue-1")).toBe(
			false,
		);
	});

	it("treats a later transition on the same issue as a new key", () => {
		const tracker = new ReviewSessionTracker();

		expect(tracker.markWebhookProcessed("2025-01-01T00:00:00Z:issue-1")).toBe(
			true,
		);
		expect(tracker.markWebhookProcessed("2025-01-02T00:00:00Z:issue-1")).toBe(
			true,
		);
	});

	it("prunes the oldest keys instead of growing without bound", () => {
		const tracker = new ReviewSessionTracker({ maxProcessedKeys: 4 });

		for (let i = 0; i < 5; i++) {
			expect(tracker.markWebhookProcessed(`key-${i}`)).toBe(true);
		}

		// The oldest half was dropped, so key-0 is forgotten and re-accepted...
		expect(tracker.markWebhookProcessed("key-0")).toBe(true);
		// ...while the most recent keys are still remembered.
		expect(tracker.markWebhookProcessed("key-4")).toBe(false);
	});
});

describe("ReviewSessionTracker - in-flight guard", () => {
	it("reports no review in flight for an unknown issue", () => {
		const tracker = new ReviewSessionTracker();
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("reports a review in flight once begun", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		expect(tracker.hasReviewInFlight("issue-1")).toBe(true);
	});

	it("releases the guard when the review completes", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "session-1");

		expect(tracker.hasReviewInFlight("issue-1")).toBe(true);
		tracker.completeReview("session-1");
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("releases the guard when the review is abandoned", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		tracker.abandonReview("issue-1");
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("expires a stuck review so the issue is not blocked forever", () => {
		let now = 1_000;
		const tracker = new ReviewSessionTracker({
			activeTtlMs: 500,
			now: () => now,
		});
		tracker.beginReview(makeContext());
		expect(tracker.hasReviewInFlight("issue-1")).toBe(true);

		now += 501;
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("completes the right review when several issues are in flight", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext({ issueId: "issue-1" }));
		tracker.attachSessionId("issue-1", "session-1");
		tracker.beginReview(makeContext({ issueId: "issue-2" }));
		tracker.attachSessionId("issue-2", "session-2");

		tracker.completeReview("session-1");

		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
		expect(tracker.hasReviewInFlight("issue-2")).toBe(true);
	});
});

describe("ReviewSessionTracker - session markers", () => {
	it("claims the context for the minted session id", () => {
		const tracker = new ReviewSessionTracker();
		const context = makeContext();
		tracker.beginReview(context);
		tracker.attachSessionId("issue-1", "session-1");

		expect(tracker.takeContext("session-1", "issue-1")).toEqual(context);
	});

	it("consumes the marker exactly once", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "session-1");

		expect(tracker.takeContext("session-1", "issue-1")).toBeDefined();
		expect(tracker.takeContext("session-1", "issue-1")).toBeUndefined();
	});

	it("does not claim an unrelated session on the same issue", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "session-1");

		// A human-started session arrives with a different id. It must consume
		// nothing... but the pending-by-issue marker is already reconciled, so the
		// only match is by session id.
		expect(tracker.takeContext("other-session")).toBeUndefined();
		expect(tracker.takeContext("session-1", "issue-1")).toBeDefined();
	});

	it("claims by issue id when the webhook beats the mint (race)", () => {
		const tracker = new ReviewSessionTracker();
		const context = makeContext();
		tracker.beginReview(context);

		// Webhook arrives before `attachSessionId` — session id is unknown to us.
		expect(tracker.takeContext("session-early", "issue-1")).toEqual(context);
	});

	it("tells the mint the marker was already claimed so it does not double-start", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.takeContext("session-early", "issue-1");

		expect(tracker.attachSessionId("issue-1", "session-early")).toBe(false);
	});

	it("confirms reconciliation when the marker is still pending", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		expect(tracker.attachSessionId("issue-1", "session-1")).toBe(true);
	});

	it("will not hijack a session started long after a failed mint", () => {
		let now = 1_000;
		const tracker = new ReviewSessionTracker({
			pendingTtlMs: 500,
			now: () => now,
		});
		tracker.beginReview(makeContext());

		now += 501;
		expect(tracker.takeContext("human-session", "issue-1")).toBeUndefined();
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("returns nothing for issues that never started a review", () => {
		const tracker = new ReviewSessionTracker();
		expect(tracker.takeContext("session-1", "issue-unknown")).toBeUndefined();
	});
});
