import { execFileSync, spawnSync } from "node:child_process";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * The hidden HTML marker that identifies a PR/MR description as Cyrus-authored.
 * Its presence is what tells our GitHub/GitLab webhook handlers that a
 * "Changes requested" or comment event should be forwarded back to Cyrus.
 */
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

/**
 * Session facts the providers need. Everything here is optional, because the
 * hook must keep working for sessions that carry none of it.
 */
export interface PrMarkerContext {
	/**
	 * GitHub handle of the person who delegated the issue, resolved from the
	 * repository's `reviewers` map. Requested as reviewer on the pull request.
	 *
	 * A bot author is what lets a colleague approve the pull request, but it
	 * notifies nobody. GitHub sends a notification only when a review is
	 * requested, so this is what actually reaches a human.
	 */
	reviewer?: string;
}

/**
 * Provider-specific knowledge about how to detect PR/MR mutating commands and
 * how to read/write the description on the underlying forge. Adding support
 * for a new forge means adding a new provider — no changes to the hook itself.
 */
export interface PrMarkerProvider {
	/** Provider name, used only for log messages. */
	readonly name: string;
	/** Returns true when `command` will create or update a PR/MR via this provider. */
	matches(command: string): boolean;
	/**
	 * Idempotently ensures the marker is present at the end of the live PR/MR
	 * description for the branch checked out at `cwd`, and that the requested
	 * reviewer is on the PR/MR. Implementations should be a no-op when no PR/MR
	 * exists yet, or when both are already in place.
	 */
	ensureMarker(cwd: string, log: ILogger, context?: PrMarkerContext): void;
}

/**
 * Append the marker to a body, preserving a single trailing newline.
 * Idempotent: returns the original body when the marker is already present.
 */
export function appendMarker(body: string | null | undefined): string {
	const current = body ?? "";
	if (current.includes(CYRUS_PR_MARKER)) {
		return current;
	}
	const trimmed = current.replace(/\s+$/, "");
	if (trimmed.length === 0) {
		return CYRUS_PR_MARKER;
	}
	return `${trimmed}\n\n${CYRUS_PR_MARKER}`;
}

/**
 * The `gh pr view --json` fields this hook reads.
 *
 * `reviewRequests` holds team entries as well as user entries, and a team entry
 * has no `login`. Both are typed as optional here so a team request is simply
 * never matched.
 */
interface GitHubPrPayload {
	body?: string;
	number?: number;
	author?: { login?: string };
	reviewRequests?: Array<{ login?: string }>;
}

/**
 * GitHub provider — uses the `gh` CLI. Also covers `gt submit` (Graphite),
 * which submits via the GitHub API and ends up viewable through `gh pr view`.
 */
export class GitHubPrMarkerProvider implements PrMarkerProvider {
	readonly name = "github";

	matches(command: string): boolean {
		// Strip surrounding shell noise; we only care whether the command line
		// contains a PR-mutating gh/gt invocation.
		return (
			/\bgh\s+pr\s+(create|edit)\b/.test(command) ||
			/\bgt\s+submit\b/.test(command)
		);
	}

	ensureMarker(cwd: string, log: ILogger, context?: PrMarkerContext): void {
		let payload: GitHubPrPayload;
		try {
			const json = execFileSync(
				"gh",
				["pr", "view", "--json", "body,number,author,reviewRequests"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			payload = JSON.parse(json) as GitHubPrPayload;
		} catch {
			// No PR for this branch yet, gh not authenticated, or not a GitHub
			// repo. Either way, nothing for us to ensure — bail silently.
			return;
		}

		if (typeof payload.number !== "number") {
			return;
		}

		// Two independent jobs. Keep them independent: a failure to write the
		// body must not cost the reviewer request, which is the only thing that
		// notifies a human.
		this.ensureBodyMarker(cwd, log, payload);
		this.ensureReviewer(cwd, log, payload, context?.reviewer);
	}

	private ensureBodyMarker(
		cwd: string,
		log: ILogger,
		payload: GitHubPrPayload,
	): void {
		const updated = appendMarker(payload.body);
		if (updated === (payload.body ?? "")) {
			return;
		}

		const result = spawnSync(
			"gh",
			["pr", "edit", String(payload.number), "--body-file", "-"],
			{
				cwd,
				input: updated,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] gh pr edit failed for #${payload.number}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitHub PR #${payload.number}`,
		);
	}

	/**
	 * Request the delegating user as reviewer.
	 *
	 * This hook fires on every `gh pr create` and every `gh pr edit`, so it can
	 * run several times for one pull request. It must therefore be idempotent,
	 * and it must never fail the session: an unmapped user, a handle GitHub does
	 * not know, or a repository the user cannot read are all normal outcomes
	 * that only deserve a log line.
	 */
	private ensureReviewer(
		cwd: string,
		log: ILogger,
		payload: GitHubPrPayload,
		reviewer: string | undefined,
	): void {
		if (!reviewer) {
			return;
		}

		// Never request the author. GitHub rejects the request, and when Cyrus
		// runs as a GitHub App the author is the bot itself.
		if (payload.author?.login?.toLowerCase() === reviewer.toLowerCase()) {
			log.debug(
				`[PrMarkerHook] Skipping reviewer @${reviewer} on #${payload.number}: they are the author`,
			);
			return;
		}

		// Already requested — for example by an earlier run of this same hook.
		const alreadyRequested = (payload.reviewRequests ?? []).some(
			(request) => request?.login?.toLowerCase() === reviewer.toLowerCase(),
		);
		if (alreadyRequested) {
			log.debug(
				`[PrMarkerHook] Reviewer @${reviewer} is already requested on #${payload.number}`,
			);
			return;
		}

		const result = spawnSync(
			"gh",
			["pr", "edit", String(payload.number), "--add-reviewer", reviewer],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] Could not request @${reviewer} as reviewer on #${payload.number}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Requested @${reviewer} as reviewer on GitHub PR #${payload.number}`,
		);
	}
}

/**
 * GitLab provider — uses the `glab` CLI.
 */
export class GitLabMrMarkerProvider implements PrMarkerProvider {
	readonly name = "gitlab";

	matches(command: string): boolean {
		return /\bglab\s+mr\s+(create|update|edit)\b/.test(command);
	}

	ensureMarker(cwd: string, log: ILogger): void {
		let payload: { description?: string; iid?: number };
		try {
			const json = execFileSync("glab", ["mr", "view", "--output", "json"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			payload = JSON.parse(json) as { description?: string; iid?: number };
		} catch {
			return;
		}

		if (typeof payload.iid !== "number") {
			return;
		}
		const updated = appendMarker(payload.description);
		if (updated === (payload.description ?? "")) {
			return;
		}

		const result = spawnSync(
			"glab",
			["mr", "update", String(payload.iid), "--description", updated],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] glab mr update failed for !${payload.iid}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitLab MR !${payload.iid}`,
		);
	}
}

/**
 * Build the PostToolUse hook that ensures Cyrus's identifying marker is
 * present on every PR/MR Cyrus creates or updates.
 *
 * Wired alongside the screenshot/stop hooks in RunnerConfigBuilder. Designed
 * around the strategy pattern: `providers` is injectable so tests can stub
 * forge interactions and so new forges can be added without touching this
 * function.
 */
export function buildPrMarkerHook(
	log: ILogger,
	providers: PrMarkerProvider[] = [
		new GitHubPrMarkerProvider(),
		new GitLabMrMarkerProvider(),
	],
	context: PrMarkerContext = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input) => {
						const post = input as PostToolUseHookInput;
						const command =
							(post.tool_input as { command?: string } | undefined)?.command ??
							"";
						const provider = providers.find((p) => p.matches(command));
						if (!provider) {
							return {};
						}
						try {
							provider.ensureMarker(post.cwd, log, context);
						} catch (err) {
							log.warn(
								`[PrMarkerHook] ${provider.name} provider threw: ${
									(err as Error).message
								}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}
