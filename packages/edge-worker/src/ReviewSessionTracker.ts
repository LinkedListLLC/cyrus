/**
 * Bookkeeping for `reviewOnStatus` review sessions.
 *
 * A status-triggered review has an awkward lifecycle: the trigger is a Linear
 * `Issue`/`update` webhook, but the session that actually runs is a *newly
 * minted* Linear agent session. This class holds the state that keeps those two
 * facts straight:
 *
 * 1. **De-duplication** — Linear re-sends webhooks and users re-save issues, so
 *    the same "moved to In Review" transition can arrive more than once.
 * 2. **Markers** — a one-shot claim that identifies exactly one Linear agent
 *    session as *our* review, so it is routed to the review runner and every
 *    other session on that issue stays a normal builder session.
 * 3. **In-flight guard** — one review per issue at a time.
 *
 * ## Markers are bound to a session id, never to an issue
 *
 * An earlier version keyed the unclaimed marker by issue id and handed it to
 * whichever agent session showed up on that issue within a time window. That is
 * unsound: a human delegating the same issue during the window would be handed
 * the review marker (and run read-only), while the real minted session found no
 * marker and ran as a **full builder with write tools** — the precise inversion
 * of what this feature exists to guarantee.
 *
 * So a marker is only ever claimable by the exact session id it was minted for.
 * The one genuine race — an `AgentSessionCreated` webhook arriving before the
 * mint call has returned that id — is resolved by *waiting* for the mint to
 * settle ({@link awaitPendingMint}), never by guessing.
 *
 * ## The claim is one-shot, and remembered
 *
 * {@link takeContext} returns a context at most once per session id. The
 * caller that wins starts the review; anything arriving later sees
 * {@link isReviewSession} and drops the event rather than falling through to
 * the builder path. This is what makes it safe for the review to be started
 * directly from the mint result *and* for Linear to echo the creation back —
 * whichever happens first wins, and the other is a no-op.
 *
 * All state is in-memory and best-effort: every entry has a TTL so a lost
 * webhook or a crashed session can never wedge an issue permanently.
 *
 * **Known limit:** the state does not survive a restart. If the process dies
 * between minting a session and starting its runner, that session is left
 * unclaimed; a later `AgentSessionCreated` echo for it would be treated as a
 * normal delegation. The window is the few milliseconds between the mint
 * returning and the runner starting, and the per-issue guard is dropped with
 * the rest of the state, so a subsequent transition can always start a fresh
 * review.
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
	/**
	 * Resolves once the mint has settled — either the session id is known
	 * ({@link ReviewSessionTracker.attachSessionId}) or the review was given up
	 * on ({@link ReviewSessionTracker.abandonReview}). Lets a webhook that beats
	 * the mint wait for the binding instead of guessing at it.
	 */
	settled: Promise<void>;
	settle: () => void;
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
	/**
	 * How long {@link ReviewSessionTracker.awaitPendingMint} will wait for an
	 * in-flight mint to settle before giving up. Bounded so a hung Linear call
	 * cannot stall an unrelated session's webhook handler.
	 */
	mintWaitMs?: number;
	/** Injectable clock (tests). */
	now?: () => number;
}

const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ACTIVE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_PROCESSED_KEYS = 500;
const DEFAULT_MINT_WAIT_MS = 10 * 1000; // 10 seconds

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
	private readonly mintWaitMs: number;
	private readonly now: () => number;

	/** Webhook keys (`createdAt:issueId`) already handled. */
	private processedWebhookKeys = new Set<string>();
	/**
	 * Reviews whose Linear session is being minted, keyed by issue id.
	 *
	 * This is *not* a claimable marker — nothing is ever handed out from here.
	 * It exists only so a webhook that arrives mid-mint can wait for the real
	 * session id via {@link awaitPendingMint}.
	 */
	private pendingByIssue = new Map<string, PendingEntry>();
	/** Claimable markers, keyed by the Linear agent session id they were minted for. */
	private contextsBySession = new Map<string, ReviewSessionContext>();
	/** Session ids already claimed as reviews, so a late echo is not re-handled. */
	private claimedSessions = new Map<string, number>();
	/** Issues with a review in flight or running. */
	private activeByIssue = new Map<string, ActiveEntry>();

	constructor(options: ReviewSessionTrackerOptions = {}) {
		this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
		this.activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
		this.maxProcessedKeys =
			options.maxProcessedKeys ?? DEFAULT_MAX_PROCESSED_KEYS;
		this.mintWaitMs = options.mintWaitMs ?? DEFAULT_MINT_WAIT_MS;
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
	 * Records that a mint is in flight for this issue so a concurrent
	 * `AgentSessionCreated` webhook can wait for the resulting session id rather
	 * than be handed a marker speculatively — see {@link awaitPendingMint}.
	 */
	beginReview(context: ReviewSessionContext): void {
		const now = this.now();
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		// Replacing an existing entry must not strand a waiter on the old promise.
		this.pendingByIssue.get(context.issueId)?.settle();
		this.pendingByIssue.set(context.issueId, {
			context,
			expiresAt: now + this.pendingTtlMs,
			settled,
			settle,
		});
		this.activeByIssue.set(context.issueId, {
			expiresAt: now + this.activeTtlMs,
		});
	}

	/**
	 * Bind the in-flight review to the session id Linear just minted for it.
	 *
	 * After this the marker is claimable — by that session id and no other.
	 * Returns `false` when there is no in-flight mint for the issue (it expired,
	 * or the review was abandoned), in which case the caller must not start a
	 * runner.
	 */
	attachSessionId(issueId: string, sessionId: string): boolean {
		const pending = this.pendingByIssue.get(issueId);
		if (!pending) return false;

		this.pendingByIssue.delete(issueId);
		if (pending.expiresAt <= this.now()) {
			// The mint took longer than the marker's lifetime. Releasing the
			// per-issue guard lets a later transition retry cleanly.
			this.activeByIssue.delete(issueId);
			pending.settle();
			return false;
		}

		this.contextsBySession.set(sessionId, pending.context);
		const active = this.activeByIssue.get(issueId);
		if (active) active.sessionId = sessionId;
		pending.settle();
		return true;
	}

	/**
	 * Wait for an in-flight mint on this issue to settle, if there is one.
	 *
	 * Callers handling an `AgentSessionCreated` webhook use this so that a
	 * webhook which overtakes the mint call still sees the session-id binding
	 * when it checks. Bounded by `mintWaitMs`: a Linear call that never returns
	 * must not stall an unrelated session. Resolves immediately when no mint is
	 * in flight, which is the overwhelmingly common case.
	 */
	async awaitPendingMint(issueId: string | undefined): Promise<void> {
		if (!issueId) return;
		const pending = this.pendingByIssue.get(issueId);
		if (!pending) return;

		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			pending.settled,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.mintWaitMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	}

	/**
	 * Claim the review marker for an agent session, if this exact session is one.
	 *
	 * Matching is by session id only — a marker is never handed to a session it
	 * was not minted for. One-shot: whichever caller claims first starts the
	 * review, and any later arrival for the same session id gets `undefined` and
	 * should consult {@link isReviewSession} before treating it as a builder.
	 */
	takeContext(sessionId: string): ReviewSessionContext | undefined {
		const context = this.contextsBySession.get(sessionId);
		if (!context) return undefined;

		this.contextsBySession.delete(sessionId);
		this.rememberClaimed(sessionId);
		const active = this.activeByIssue.get(context.issueId);
		if (active) active.sessionId = sessionId;
		return context;
	}

	/**
	 * Adopt a session Linear has *already* created as a review.
	 *
	 * The status trigger has to mint its own session, which is why it needs the
	 * {@link beginReview} → {@link attachSessionId} → {@link takeContext} dance:
	 * the session id does not exist when the review is decided on. A
	 * delegation-triggered review (`reviewOnDelegateInStatus`) has the opposite
	 * shape — Linear created the session *before* telling us, so the id is known
	 * up front and there is no mint to race.
	 *
	 * This records the claim directly and deliberately leaves the per-issue
	 * pending/active state untouched, so a concurrent status-triggered mint on
	 * the same issue is neither clobbered nor stranded on a settled promise.
	 */
	adoptReviewSession(sessionId: string): void {
		this.rememberClaimed(sessionId);
	}

	/**
	 * Has this session id already been claimed as a review?
	 *
	 * Lets a duplicate or late `AgentSessionCreated` for a review we already
	 * started be dropped, instead of falling through and being started a second
	 * time as a builder session.
	 */
	isReviewSession(sessionId: string): boolean {
		const expiresAt = this.claimedSessions.get(sessionId);
		if (expiresAt === undefined) return false;
		if (expiresAt <= this.now()) {
			this.claimedSessions.delete(sessionId);
			return false;
		}
		return true;
	}

	/** Give up on a review that never got off the ground (mint or start failed). */
	abandonReview(issueId: string, sessionId?: string): void {
		this.pendingByIssue.get(issueId)?.settle();
		this.pendingByIssue.delete(issueId);
		this.activeByIssue.delete(issueId);
		if (sessionId) this.contextsBySession.delete(sessionId);
	}

	/**
	 * Record a claimed session id with a TTL, pruning expired entries so the map
	 * stays bounded by the number of reviews in the active window.
	 */
	private rememberClaimed(sessionId: string): void {
		const now = this.now();
		for (const [id, expiresAt] of this.claimedSessions.entries()) {
			if (expiresAt <= now) this.claimedSessions.delete(id);
		}
		this.claimedSessions.set(sessionId, now + this.activeTtlMs);
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
