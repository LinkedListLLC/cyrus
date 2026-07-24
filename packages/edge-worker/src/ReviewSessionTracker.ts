/**
 * Bookkeeping for `reviewOnStatus` review sessions.
 *
 * A status-triggered review has an awkward lifecycle: the trigger is a Linear
 * `Issue`/`update` webhook, but the session that actually runs is created
 * asynchronously by minting a *new* Linear agent session — which comes back to
 * us as an `AgentSessionCreated` webhook that looks exactly like a normal
 * delegation. This class holds the state that keeps those two facts straight:
 *
 * 1. **De-duplication** — Linear re-sends webhooks and users re-save issues, so
 *    the same "moved to In Review" transition can arrive more than once.
 * 2. **Markers** — so the incoming `AgentSessionCreated` webhook can be
 *    recognised as *our* review session and routed to the review runner
 *    instead of the builder.
 * 3. **In-flight guard** — one review per issue at a time.
 *
 * All state is in-memory and best-effort: every entry has a TTL so a lost
 * webhook or a crashed session can never wedge an issue permanently, and a
 * stale marker can never hijack an unrelated human-started session.
 */

/** Everything the review runner needs, carried from trigger to session start. */
export interface ReviewSessionContext {
	/** Linear issue id (uuid). */
	issueId: string;
	/** Human-readable identifier, e.g. `CYR-5`. */
	issueIdentifier: string;
	/** Repository config id the issue routed to. */
	repositoryId: string;
	/** Linear workspace (organization) id. */
	linearWorkspaceId: string;
	/** The workflow state name that triggered the review, e.g. `In Review`. */
	stateName: string;
}

interface PendingEntry {
	context: ReviewSessionContext;
	expiresAt: number;
}

interface ActiveEntry {
	sessionId?: string;
	expiresAt: number;
}

export interface ReviewSessionTrackerOptions {
	/**
	 * How long an unclaimed marker stays valid. Covers the gap between minting
	 * a Linear agent session and its `AgentSessionCreated` webhook arriving.
	 */
	pendingTtlMs?: number;
	/**
	 * How long an issue is considered "already being reviewed". Bounds the
	 * in-flight guard so a session that dies without notifying us does not
	 * block reviews on that issue forever.
	 */
	activeTtlMs?: number;
	/** Cap on remembered webhook keys before the oldest half is pruned. */
	maxProcessedKeys?: number;
	/** Injectable clock (tests). */
	now?: () => number;
}

const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ACTIVE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_PROCESSED_KEYS = 500;

/**
 * Does a workflow state name match a repository's configured `reviewOnStatus`?
 *
 * Matching is case-insensitive and whitespace-trimmed — Linear state names are
 * free text typed by humans ("In Review", "in review", "In review ").
 */
export function matchesReviewStatus(
	configured: string | undefined | null,
	stateName: string | undefined | null,
): boolean {
	if (!configured || !stateName) return false;
	const normalize = (value: string) => value.trim().toLowerCase();
	const configuredName = normalize(configured);
	if (configuredName.length === 0) return false;
	return configuredName === normalize(stateName);
}

export class ReviewSessionTracker {
	private readonly pendingTtlMs: number;
	private readonly activeTtlMs: number;
	private readonly maxProcessedKeys: number;
	private readonly now: () => number;

	/** Webhook keys (`createdAt:issueId`) already handled. */
	private processedWebhookKeys = new Set<string>();
	/** Markers awaiting a minted session id, keyed by issue id. */
	private pendingByIssue = new Map<string, PendingEntry>();
	/** Markers with a known session id, keyed by Linear agent session id. */
	private contextsBySession = new Map<string, ReviewSessionContext>();
	/** Issues with a review in flight or running. */
	private activeByIssue = new Map<string, ActiveEntry>();

	constructor(options: ReviewSessionTrackerOptions = {}) {
		this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
		this.activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
		this.maxProcessedKeys =
			options.maxProcessedKeys ?? DEFAULT_MAX_PROCESSED_KEYS;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Claim a trigger webhook. Returns `true` the first time a key is seen and
	 * `false` for every replay, so callers can `if (!markWebhookProcessed(k)) return;`.
	 */
	markWebhookProcessed(key: string): boolean {
		if (this.processedWebhookKeys.has(key)) return false;
		this.processedWebhookKeys.add(key);

		// Prevent unbounded growth — drop the oldest half when the set gets large.
		if (this.processedWebhookKeys.size > this.maxProcessedKeys) {
			const keys = [...this.processedWebhookKeys];
			for (const old of keys.slice(0, Math.floor(this.maxProcessedKeys / 2))) {
				this.processedWebhookKeys.delete(old);
			}
		}
		return true;
	}

	/** Is a review already in flight (or running) for this issue? */
	hasReviewInFlight(issueId: string): boolean {
		const entry = this.activeByIssue.get(issueId);
		if (!entry) return false;
		if (entry.expiresAt <= this.now()) {
			this.activeByIssue.delete(issueId);
			return false;
		}
		return true;
	}

	/**
	 * Register a review before minting its Linear session.
	 *
	 * The marker is keyed by issue id first because the `AgentSessionCreated`
	 * webhook can in principle land before the mint call resolves — at that
	 * point the session id is not known to us yet, but the issue id is.
	 */
	beginReview(context: ReviewSessionContext): void {
		const now = this.now();
		this.pendingByIssue.set(context.issueId, {
			context,
			expiresAt: now + this.pendingTtlMs,
		});
		this.activeByIssue.set(context.issueId, {
			expiresAt: now + this.activeTtlMs,
		});
	}

	/**
	 * Reconcile the pending marker to the freshly minted session id.
	 *
	 * Returns `false` when the marker was already consumed — i.e. the webhook
	 * won the race and the review is already starting. Callers must not start a
	 * second runner in that case.
	 */
	attachSessionId(issueId: string, sessionId: string): boolean {
		const pending = this.pendingByIssue.get(issueId);
		if (!pending) return false;

		this.pendingByIssue.delete(issueId);
		this.contextsBySession.set(sessionId, pending.context);
		const active = this.activeByIssue.get(issueId);
		if (active) active.sessionId = sessionId;
		return true;
	}

	/**
	 * Claim the review marker for an incoming agent session, if there is one.
	 *
	 * Consuming is one-shot: the session is now known to be a review, and any
	 * later session on the same issue is a normal (builder) session.
	 */
	takeContext(
		sessionId: string,
		issueId?: string,
	): ReviewSessionContext | undefined {
		const bySession = this.contextsBySession.get(sessionId);
		if (bySession) {
			this.contextsBySession.delete(sessionId);
			const active = this.activeByIssue.get(bySession.issueId);
			if (active) active.sessionId = sessionId;
			return bySession;
		}

		if (!issueId) return undefined;
		const pending = this.pendingByIssue.get(issueId);
		if (!pending) return undefined;

		// An expired marker is not ours to claim — a human may have started a
		// session on this issue long after our mint failed.
		this.pendingByIssue.delete(issueId);
		if (pending.expiresAt <= this.now()) {
			this.activeByIssue.delete(issueId);
			return undefined;
		}

		const active = this.activeByIssue.get(issueId);
		if (active) active.sessionId = sessionId;
		return pending.context;
	}

	/** Give up on a review that never got off the ground (mint or start failed). */
	abandonReview(issueId: string, sessionId?: string): void {
		this.pendingByIssue.delete(issueId);
		this.activeByIssue.delete(issueId);
		if (sessionId) this.contextsBySession.delete(sessionId);
	}

	/** A review session finished (or errored) — release the per-issue guard. */
	completeReview(sessionId: string): void {
		this.contextsBySession.delete(sessionId);
		for (const [issueId, entry] of this.activeByIssue.entries()) {
			if (entry.sessionId === sessionId) {
				this.activeByIssue.delete(issueId);
				return;
			}
		}
	}
}
