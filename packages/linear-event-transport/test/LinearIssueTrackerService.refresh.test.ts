import type { LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * Build a LinearClient stub with the GraphQL client surface the service patches.
 */
function createLinearClient() {
	const setHeader = vi.fn();
	const client = {
		request: vi.fn(),
		setHeader,
	};
	return { client } as unknown as LinearClient & {
		client: { request: ReturnType<typeof vi.fn>; setHeader: typeof setHeader };
	};
}

describe("LinearIssueTrackerService.refreshAccessToken", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refreshes the token, updates the header, and reports the new tokens", async () => {
		const linearClient = createLinearClient();
		const onTokenRefresh = vi.fn();
		const service = new LinearIssueTrackerService(linearClient, {
			clientId: "client-id",
			clientSecret: "client-secret",
			refreshToken: "old-refresh-token",
			workspaceId: "workspace-refresh-ok",
			onTokenRefresh,
		});

		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			}),
		});

		const token = await service.refreshAccessToken();

		expect(token).toBe("new-access-token");
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.linear.app/oauth/token",
			expect.objectContaining({ method: "POST" }),
		);
		expect(linearClient.client.setHeader).toHaveBeenCalledWith(
			"Authorization",
			"Bearer new-access-token",
		);
		expect(onTokenRefresh).toHaveBeenCalledWith({
			accessToken: "new-access-token",
			refreshToken: "new-refresh-token",
		});
	});

	it("returns null when OAuth refresh is not configured", async () => {
		const service = new LinearIssueTrackerService(createLinearClient());

		await expect(service.refreshAccessToken()).resolves.toBeNull();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects when the OAuth endpoint refuses the refresh", async () => {
		const service = new LinearIssueTrackerService(createLinearClient(), {
			clientId: "client-id",
			clientSecret: "client-secret",
			refreshToken: "old-refresh-token",
			workspaceId: "workspace-refresh-failure",
		});

		mockFetch.mockResolvedValue({ ok: false, status: 400 });

		await expect(service.refreshAccessToken()).rejects.toThrow(
			"Token refresh failed: 400",
		);
	});
});
