import { describe, expect, it } from "vitest";
import {
	toAcpNameValueList,
	translateMcpConfigToAcp,
} from "../src/backend/mcpTranslator.js";

describe("toAcpNameValueList", () => {
	it("converts record to name/value array", () => {
		expect(
			toAcpNameValueList({ Authorization: "Bearer x", "X-A": "1" }),
		).toEqual([
			{ name: "Authorization", value: "Bearer x" },
			{ name: "X-A", value: "1" },
		]);
	});

	it("handles undefined", () => {
		expect(toAcpNameValueList(undefined)).toEqual([]);
	});
});

describe("translateMcpConfigToAcp", () => {
	it("encodes HTTP headers as name/value arrays", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer tok" },
				} as any,
			},
			mcpCapabilities: { http: true },
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			name: "linear",
			type: "http",
			url: "https://mcp.linear.app/mcp",
			headers: [{ name: "Authorization", value: "Bearer tok" }],
		});
	});

	it("encodes stdio env as name/value arrays and requires args", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				slack: {
					command: "npx",
					args: ["-y", "slack-mcp"],
					env: { SLACK_TOKEN: "xoxb" },
				} as any,
			},
		});

		expect(servers[0]).toMatchObject({
			name: "slack",
			command: "npx",
			args: ["-y", "slack-mcp"],
			env: [{ name: "SLACK_TOKEN", value: "xoxb" }],
		});
	});

	it("defaults stdio args to empty array", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				foo: { command: "/bin/foo" } as any,
			},
		});
		expect(servers[0]).toMatchObject({ args: [] });
	});

	it("skips HTTP when mcpCapabilities.http is false", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
			},
			mcpCapabilities: { http: false },
		});
		expect(servers).toHaveLength(0);
	});

	it("skips in-process SDK servers", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				local: {
					listTools: async () => [],
					callTool: async () => ({}),
				} as any,
			},
		});
		expect(servers).toHaveLength(0);
	});
});
