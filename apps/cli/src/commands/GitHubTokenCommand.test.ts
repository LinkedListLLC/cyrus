import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CachedInstallationToken,
	resolveGitHubToken,
	TOKEN_CACHE_FILENAME,
} from "./GitHubTokenCommand.js";

const HOUR_MS = 60 * 60 * 1000;
/** A fixed clock, so the tests never depend on the wall clock. */
const NOW = Date.parse("2026-08-02T12:00:00.000Z");

let cyrusHome: string;

function cachePath(): string {
	return join(cyrusHome, TOKEN_CACHE_FILENAME);
}

function writeCache(entry: Partial<CachedInstallationToken>): void {
	writeFileSync(
		cachePath(),
		JSON.stringify({
			token: "cached-token",
			expiresAt: new Date(NOW + HOUR_MS).toISOString(),
			appId: "12345",
			installationId: "67890",
			...entry,
		}),
	);
}

const APP_ENV = {
	GITHUB_APP_ID: "12345",
	GITHUB_APP_INSTALLATION_ID: "67890",
};

beforeEach(() => {
	cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-github-token-"));
});

afterEach(() => {
	rmSync(cyrusHome, { recursive: true, force: true });
});

describe("resolveGitHubToken — GitHub App path", () => {
	it("mints a token when no cache exists, and caches it at mode 0600", async () => {
		const mint = vi
			.fn()
			.mockResolvedValue({ token: "minted-token", expiresAt: NOW + HOUR_MS });

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("minted-token");
		expect(mint).toHaveBeenCalledWith({
			appId: "12345",
			installationId: "67890",
			privateKeyPath: join(cyrusHome, "github-app.pem"),
		});

		const written = JSON.parse(
			readFileSync(cachePath(), "utf-8"),
		) as CachedInstallationToken;
		expect(written.token).toBe("minted-token");
		expect(written.appId).toBe("12345");
		// 0o777 masks off the file-type bits that statSync also reports.
		expect(statSync(cachePath()).mode & 0o777).toBe(0o600);
	});

	it("returns the cached token without minting when it has more than 5 minutes left", async () => {
		writeCache({ expiresAt: new Date(NOW + 6 * 60 * 1000).toISOString() });
		const mint = vi.fn();

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("cached-token");
		expect(mint).not.toHaveBeenCalled();
	});

	it("refreshes when the cached token has less than 5 minutes left", async () => {
		writeCache({ expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString() });
		const mint = vi
			.fn()
			.mockResolvedValue({ token: "fresh-token", expiresAt: NOW + HOUR_MS });

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("fresh-token");
		expect(mint).toHaveBeenCalledTimes(1);
	});

	/**
	 * Acceptance criterion 3: a session that runs longer than one hour must
	 * still push and open a pull request. The cache is the only thing between
	 * that session and an expired credential, so an already-expired cache must
	 * produce a new token instead of the stale one.
	 */
	it("mints a new token when the cached token has already expired", async () => {
		writeCache({
			token: "expired-token",
			expiresAt: new Date(NOW - 1000).toISOString(),
		});
		const mint = vi.fn().mockResolvedValue({
			token: "second-hour-token",
			expiresAt: NOW + HOUR_MS,
		});

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("second-hour-token");
		const written = JSON.parse(
			readFileSync(cachePath(), "utf-8"),
		) as CachedInstallationToken;
		expect(written.token).toBe("second-hour-token");
	});

	it("ignores a cache minted for a different App", async () => {
		writeCache({ appId: "99999" });
		const mint = vi.fn().mockResolvedValue({
			token: "correct-app-token",
			expiresAt: NOW + HOUR_MS,
		});

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("correct-app-token");
	});

	it("ignores a corrupt cache file", async () => {
		writeFileSync(cachePath(), "{ not json");
		const mint = vi.fn().mockResolvedValue({
			token: "recovered-token",
			expiresAt: NOW + HOUR_MS,
		});

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("recovered-token");
	});
});

describe("resolveGitHubToken — personal access token fallback", () => {
	it("prints GITHUB_TOKEN when the App variables are absent", async () => {
		const mint = vi.fn();

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { GITHUB_TOKEN: "pat-value" },
			now: () => NOW,
			mint,
		});

		expect(token).toBe("pat-value");
		expect(mint).not.toHaveBeenCalled();
	});

	it("accepts GH_TOKEN, the name the container entrypoint uses", async () => {
		const token = await resolveGitHubToken({
			cyrusHome,
			env: { GH_TOKEN: "gh-token-value" },
			now: () => NOW,
			mint: vi.fn(),
		});

		expect(token).toBe("gh-token-value");
	});

	it("ignores App variables that are set but empty", async () => {
		const token = await resolveGitHubToken({
			cyrusHome,
			env: {
				GITHUB_APP_ID: "  ",
				GITHUB_APP_INSTALLATION_ID: "",
				GITHUB_TOKEN: "pat-value",
			},
			now: () => NOW,
			mint: vi.fn(),
		});

		expect(token).toBe("pat-value");
	});

	it("falls back to the personal access token when minting fails, and warns", async () => {
		const warn = vi.fn();
		const mint = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));

		const token = await resolveGitHubToken({
			cyrusHome,
			env: { ...APP_ENV, GITHUB_TOKEN: "pat-value" },
			now: () => NOW,
			mint,
			warn,
		});

		expect(token).toBe("pat-value");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("401 Unauthorized");
	});

	it("throws when minting fails and no personal access token is set", async () => {
		const mint = vi.fn().mockRejectedValue(new Error("no such file"));

		await expect(
			resolveGitHubToken({
				cyrusHome,
				env: { ...APP_ENV },
				now: () => NOW,
				mint,
				warn: vi.fn(),
			}),
		).rejects.toThrow(/Could not mint a GitHub App token: no such file/);
	});

	it("throws when neither the App variables nor a personal access token are set", async () => {
		await expect(
			resolveGitHubToken({
				cyrusHome,
				env: {},
				now: () => NOW,
				mint: vi.fn(),
			}),
		).rejects.toThrow(/No GitHub credential is available/);
	});
});
