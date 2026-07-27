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

		expect(tracker.takeContext("session-1")).toEqual(context);
	});

	it("consumes the marker exactly once", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "session-1");

		expect(tracker.takeContext("session-1")).toBeDefined();
		expect(tracker.takeContext("session-1")).toBeUndefined();
	});

	it("confirms the binding when a mint is in flight", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		expect(tracker.attachSessionId("issue-1", "session-1")).toBe(true);
	});

	it("refuses to bind when the review was already abandoned", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.abandonReview("issue-1");

		expect(tracker.attachSessionId("issue-1", "session-1")).toBe(false);
		expect(tracker.takeContext("session-1")).toBeUndefined();
	});

	it("refuses to bind, and releases the guard, when the mint outlived the marker", () => {
		let now = 1_000;
		const tracker = new ReviewSessionTracker({
			pendingTtlMs: 500,
			now: () => now,
		});
		tracker.beginReview(makeContext());

		now += 501;
		expect(tracker.attachSessionId("issue-1", "session-late")).toBe(false);
		expect(tracker.takeContext("session-late")).toBeUndefined();
		// A later transition must still be able to start a fresh review.
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("returns nothing for a session that was never a review", () => {
		const tracker = new ReviewSessionTracker();
		expect(tracker.takeContext("session-1")).toBeUndefined();
	});
});

/**
 * CYR-16 / B4. The marker used to be keyed by issue id and handed to any agent
 * session appearing on that issue inside a 5-minute window. These pin the
 * property that replaced it: a marker belongs to exactly one session id.
 */
describe("ReviewSessionTracker - the marker belongs to one session (CYR-16 / B4)", () => {
	it("does not hand the review marker to a different session on the same issue", () => {
		const tracker = new ReviewSessionTracker();
		const context = makeContext();
		tracker.beginReview(context);
		tracker.attachSessionId("issue-1", "review-session");

		// A human delegates the same issue. It gets nothing...
		expect(tracker.takeContext("human-session")).toBeUndefined();
		expect(tracker.isReviewSession("human-session")).toBe(false);
		// ...and the real review session still has its marker.
		expect(tracker.takeContext("review-session")).toEqual(context);
	});

	it("gives a mid-mint human session nothing, even before the session id is known", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		// The mint has not returned yet: no session id is bound. Previously this
		// window handed the marker to whoever asked; now nothing is claimable.
		expect(tracker.takeContext("human-session")).toBeUndefined();

		// And the real session, once minted, still gets it.
		expect(tracker.attachSessionId("issue-1", "review-session")).toBe(true);
		expect(tracker.takeContext("review-session")).toBeDefined();
	});

	it("remembers a claimed session so a late echo is not restarted as a builder", () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "review-session");
		tracker.takeContext("review-session");

		// The marker is spent, but the session is still recognisably a review.
		expect(tracker.takeContext("review-session")).toBeUndefined();
		expect(tracker.isReviewSession("review-session")).toBe(true);
		expect(tracker.isReviewSession("human-session")).toBe(false);
	});

	it("expires the claimed-session memory rather than growing without bound", () => {
		let now = 1_000;
		const tracker = new ReviewSessionTracker({
			activeTtlMs: 500,
			now: () => now,
		});
		tracker.beginReview(makeContext());
		tracker.attachSessionId("issue-1", "review-session");
		tracker.takeContext("review-session");

		expect(tracker.isReviewSession("review-session")).toBe(true);
		now += 501;
		expect(tracker.isReviewSession("review-session")).toBe(false);
	});
});

describe("ReviewSessionTracker - adoptReviewSession (delegated review, CYR-35)", () => {
	it("claims the session and marks the issue in flight", () => {
		const tracker = new ReviewSessionTracker();

		tracker.adoptReviewSession("delegated-session", "issue-1");

		// Recognisably a review, so a late echo is not restarted as a builder.
		expect(tracker.isReviewSession("delegated-session")).toBe(true);
		// In flight, so a later `reviewOnStatus` transition declines rather than
		// starting a second concurrent review of the same PR.
		expect(tracker.hasReviewInFlight("issue-1")).toBe(true);
	});

	it("releases the in-flight guard when the delegated review completes", () => {
		const tracker = new ReviewSessionTracker();
		tracker.adoptReviewSession("delegated-session", "issue-1");

		tracker.completeReview("delegated-session");

		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});

	it("expires the guard so a crashed delegated review cannot wedge the issue", () => {
		let now = 1_000;
		const tracker = new ReviewSessionTracker({
			activeTtlMs: 500,
			now: () => now,
		});
		tracker.adoptReviewSession("delegated-session", "issue-1");
		expect(tracker.hasReviewInFlight("issue-1")).toBe(true);

		now += 501;
		expect(tracker.hasReviewInFlight("issue-1")).toBe(false);
	});
});

describe("ReviewSessionTracker - awaitPendingMint", () => {
	it("resolves immediately when no mint is in flight", async () => {
		const tracker = new ReviewSessionTracker();
		await expect(tracker.awaitPendingMint("issue-1")).resolves.toBeUndefined();
		await expect(tracker.awaitPendingMint(undefined)).resolves.toBeUndefined();
	});

	it("waits for the mint to bind a session id, then lets the caller see it", async () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		let settled = false;
		const waiter = tracker.awaitPendingMint("issue-1").then(() => {
			settled = true;
		});

		// Still in flight — the waiter must not have resolved yet.
		await Promise.resolve();
		expect(settled).toBe(false);

		tracker.attachSessionId("issue-1", "review-session");
		await waiter;

		expect(settled).toBe(true);
		expect(tracker.takeContext("review-session")).toBeDefined();
	});

	it("stops waiting when the review is abandoned", async () => {
		const tracker = new ReviewSessionTracker();
		tracker.beginReview(makeContext());

		const waiter = tracker.awaitPendingMint("issue-1");
		tracker.abandonReview("issue-1");

		await expect(waiter).resolves.toBeUndefined();
	});

	it("gives up after mintWaitMs so a hung mint cannot stall other sessions", async () => {
		const tracker = new ReviewSessionTracker({ mintWaitMs: 5 });
		tracker.beginReview(makeContext());

		// Never bound — resolves on the timeout rather than hanging.
		await expect(tracker.awaitPendingMint("issue-1")).resolves.toBeUndefined();
	});
});
