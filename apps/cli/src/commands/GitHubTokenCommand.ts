import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	GitHubAppTokenProvider,
	type InstallationToken,
	TOKEN_REFRESH_MARGIN_MS,
} from "cyrus-github-event-transport";

/** Name of the on-disk token cache, kept inside the Cyrus home directory. */
export const TOKEN_CACHE_FILENAME = "github-token.json";

/** Name of the GitHub App private key, kept inside the Cyrus home directory. */
export const PRIVATE_KEY_FILENAME = "github-app.pem";

/**
 * Shape of the on-disk cache.
 *
 * `appId` and `installationId` are recorded so a token minted for a different
 * App is never handed out after the operator changes the configuration.
 */
export interface CachedInstallationToken {
	token: string;
	/** ISO 8601 instant, the same format the GitHub API returns. */
	expiresAt: string;
	appId: string;
	installationId: string;
}

export interface ResolveGitHubTokenOptions {
	/** The Cyrus home directory that holds the private key and the cache. */
	cyrusHome: string;
	/** Environment to read. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Clock, injected for tests. */
	now?: () => number;
	/**
	 * Minting step, injected for tests. The default signs an App JWT with
	 * `GitHubAppTokenProvider` and exchanges it for an installation token.
	 */
	mint?: (config: {
		appId: string;
		installationId: string;
		privateKeyPath: string;
	}) => Promise<InstallationToken>;
	/** Where warnings go. Never stdout — stdout carries the token alone. */
	warn?: (message: string) => void;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

/**
 * Read the cache, and return it only when it is still usable.
 *
 * Any unreadable, malformed, stale or foreign-App cache is treated as absent:
 * the caller then mints a new token, which is always safe.
 */
export function readTokenCache(
	cachePath: string,
	appId: string,
	installationId: string,
	now: number,
): string | undefined {
	let parsed: CachedInstallationToken;
	try {
		parsed = JSON.parse(
			readFileSync(cachePath, "utf-8"),
		) as CachedInstallationToken;
	} catch {
		return undefined;
	}

	if (
		typeof parsed?.token !== "string" ||
		parsed.token.length === 0 ||
		parsed.appId !== appId ||
		parsed.installationId !== installationId
	) {
		return undefined;
	}

	const expiresAt = Date.parse(parsed.expiresAt);
	if (Number.isNaN(expiresAt)) {
		return undefined;
	}
	// Same 5-minute margin the in-process provider uses, so a token handed to a
	// long git push or gh call does not expire while that call runs.
	if (now >= expiresAt - TOKEN_REFRESH_MARGIN_MS) {
		return undefined;
	}
	return parsed.token;
}

/**
 * Write the cache at mode 0600.
 *
 * The write goes to a per-process temporary file and is then renamed, because
 * two agent sessions can call `cyrus github-token` at the same instant and a
 * partially written file must never be read as a token.
 */
export function writeTokenCache(
	cachePath: string,
	entry: CachedInstallationToken,
): void {
	mkdirSync(dirname(cachePath), { recursive: true });
	const tempPath = `${cachePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(entry, null, 2)}\n`, {
			mode: 0o600,
		});
		// `mode` above applies only when the file is created, so set it again.
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, cachePath);
		chmodSync(cachePath, 0o600);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

async function defaultMint(config: {
	appId: string;
	installationId: string;
	privateKeyPath: string;
}): Promise<InstallationToken> {
	return new GitHubAppTokenProvider(config).getTokenWithExpiry();
}

/**
 * Resolve a GitHub credential that is valid right now.
 *
 * Order:
 * 1. A cached App installation token with more than 5 minutes of life left.
 * 2. A freshly minted App installation token.
 * 3. The `GITHUB_TOKEN` / `GH_TOKEN` personal access token.
 *
 * Steps 1 and 2 apply only when `GITHUB_APP_ID` and
 * `GITHUB_APP_INSTALLATION_ID` are both set. Without them the behaviour is the
 * personal-access-token behaviour Cyrus had before the App existed.
 *
 * @throws when no credential can be produced.
 */
export async function resolveGitHubToken(
	options: ResolveGitHubTokenOptions,
): Promise<string> {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const mint = options.mint ?? defaultMint;
	const warn =
		options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

	const appId = readEnv(env, "GITHUB_APP_ID");
	const installationId = readEnv(env, "GITHUB_APP_INSTALLATION_ID");
	// GH_TOKEN is read as well as GITHUB_TOKEN because the container entrypoint
	// takes the personal access token under that name.
	const personalAccessToken =
		readEnv(env, "GITHUB_TOKEN") ?? readEnv(env, "GH_TOKEN");

	if (!appId || !installationId) {
		if (personalAccessToken) {
			return personalAccessToken;
		}
		throw new Error(
			"No GitHub credential is available. Set GITHUB_APP_ID and " +
				`GITHUB_APP_INSTALLATION_ID, and put the App private key at ` +
				`${join(options.cyrusHome, PRIVATE_KEY_FILENAME)}. As an alternative, ` +
				"set GITHUB_TOKEN to a personal access token.",
		);
	}

	const cachePath = join(options.cyrusHome, TOKEN_CACHE_FILENAME);
	const cached = readTokenCache(cachePath, appId, installationId, now());
	if (cached) {
		return cached;
	}

	try {
		const minted = await mint({
			appId,
			installationId,
			privateKeyPath: join(options.cyrusHome, PRIVATE_KEY_FILENAME),
		});
		try {
			writeTokenCache(cachePath, {
				token: minted.token,
				expiresAt: new Date(minted.expiresAt).toISOString(),
				appId,
				installationId,
			});
		} catch (error) {
			// A cache that cannot be written costs speed, not correctness.
			warn(
				`[cyrus github-token] Could not write ${cachePath}: ${
					(error as Error).message
				}`,
			);
		}
		return minted.token;
	} catch (error) {
		const reason = (error as Error).message;
		if (personalAccessToken) {
			// Same fallback order as EdgeWorker.resolveGitHubToken. Say so loudly:
			// pull requests opened with the personal access token carry a person's
			// name, which is the problem the App was installed to solve.
			warn(
				`[cyrus github-token] Could not mint a GitHub App token (${reason}). ` +
					"Falling back to the personal access token.",
			);
			return personalAccessToken;
		}
		throw new Error(`Could not mint a GitHub App token: ${reason}`);
	}
}

/**
 * `cyrus github-token` — print a valid GitHub token to stdout, then exit.
 *
 * The `gh` wrapper and the git credential helper in the container both call
 * this on every invocation, because an App installation token lives for one
 * hour and agent sessions run for longer. Nothing except the token goes to
 * stdout: both callers read stdout and would treat a log line as a credential.
 *
 * This command does not build an `Application`, unlike the other commands here.
 * The `Application` constructor writes progress lines to stdout, which would
 * corrupt the output.
 */
export class GitHubTokenCommand {
	constructor(private readonly cyrusHome: string) {}

	async execute(_args: string[] = []): Promise<void> {
		try {
			const token = await resolveGitHubToken({ cyrusHome: this.cyrusHome });
			process.stdout.write(`${token}\n`);
		} catch (error) {
			process.stderr.write(
				`[cyrus github-token] ${(error as Error).message}\n`,
			);
			// Set the code instead of calling process.exit, so that the writes
			// above reach a pipe before the process ends.
			process.exitCode = 1;
		}
	}
}
