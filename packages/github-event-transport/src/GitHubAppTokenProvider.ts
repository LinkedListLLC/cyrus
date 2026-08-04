import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GitHubAppTokenProviderConfig {
	appId: string;
	installationId: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

/** How long before expiry a cached token is discarded and minted again. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** An installation token together with the instant it stops being valid. */
export interface InstallationToken {
	token: string;
	/** Expiry as epoch milliseconds. */
	expiresAt: number;
}

/**
 * Mints and caches GitHub App installation tokens for self-hosted users.
 *
 * Uses the App's private key to sign a JWT, then exchanges it for a
 * short-lived installation access token via the GitHub API.
 * Tokens are cached and refreshed 5 minutes before expiry.
 */
export class GitHubAppTokenProvider {
	private config: GitHubAppTokenProviderConfig;
	private cachedToken: string | null = null;
	private expiresAt = 0;
	private privateKeyPromise: Promise<string> | null = null;
	private appSlugPromise: Promise<string> | null = null;

	constructor(config: GitHubAppTokenProviderConfig) {
		this.config = config;
	}

	/**
	 * Read the App's URL slug from GitHub — for example `cyrus-william`.
	 *
	 * The slug is the handle a person types to @mention this agent on a pull
	 * request, so it is the only name the agent can tell people to use. It is a
	 * property of the App itself, which makes it the one source that is always
	 * correct for the App that is actually running.
	 *
	 * The result is cached for the life of the process. The slug changes only
	 * when somebody renames the App, which is rare and needs a restart anyway.
	 */
	getAppSlug(): Promise<string> {
		if (!this.appSlugPromise) {
			this.appSlugPromise = this.fetchAppSlug().catch((error) => {
				// Do not cache a failure: a transient network error must not
				// deny the slug for the rest of the process lifetime.
				this.appSlugPromise = null;
				throw error;
			});
		}
		return this.appSlugPromise;
	}

	private async fetchAppSlug(): Promise<string> {
		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		const response = await fetch(`${apiBase}/app`, {
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to read the App: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as { slug?: string };
		if (!data.slug) {
			throw new Error(
				"[GitHubAppTokenProvider] The App response contains no slug",
			);
		}

		return data.slug;
	}

	/**
	 * Get a valid installation access token.
	 * Returns cached token if still valid, otherwise mints a new one.
	 */
	async getToken(): Promise<string> {
		return (await this.getTokenWithExpiry()).token;
	}

	/**
	 * Get a valid installation access token together with its expiry.
	 *
	 * Callers that must survive their own process (for example the
	 * `cyrus github-token` CLI, which exits after every call) need the expiry
	 * to keep a cache of their own. The in-process cache below is useless to
	 * them.
	 */
	async getTokenWithExpiry(): Promise<InstallationToken> {
		// Refresh 5 minutes before expiry
		if (
			this.cachedToken &&
			Date.now() < this.expiresAt - TOKEN_REFRESH_MARGIN_MS
		) {
			return { token: this.cachedToken, expiresAt: this.expiresAt };
		}

		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		const response = await fetch(
			`${apiBase}/app/installations/${this.config.installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to create installation token: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};

		this.cachedToken = data.token;
		this.expiresAt = new Date(data.expires_at).getTime();

		return { token: this.cachedToken, expiresAt: this.expiresAt };
	}

	private loadPrivateKey(): Promise<string> {
		if (!this.privateKeyPromise) {
			this.privateKeyPromise = readFile(this.config.privateKeyPath, "utf-8");
		}
		return this.privateKeyPromise;
	}
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses Node's native crypto — no external JWT library needed.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 10 * 60,
			iss: appId,
		}),
	).toString("base64url");

	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey, "base64url");

	return `${header}.${payload}.${signature}`;
}
