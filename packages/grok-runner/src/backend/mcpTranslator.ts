import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "cyrus-core";
import type {
	AcpMcpCapabilities,
	AcpMcpServer,
	AcpNameValue,
} from "./acpTypes.js";

function recordToNameValueList(
	record: Record<string, string> | undefined,
): AcpNameValue[] {
	if (!record) return [];
	return Object.entries(record).map(([name, value]) => ({
		name,
		value: String(value),
	}));
}

function autoDetectMcpConfigPath(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) return undefined;
	const mcpPath = join(workingDirectory, ".mcp.json");
	if (!existsSync(mcpPath)) return undefined;
	try {
		JSON.parse(readFileSync(mcpPath, "utf8"));
		return mcpPath;
	} catch {
		console.warn(
			`[GrokRunner] Found .mcp.json at ${mcpPath} but it is invalid JSON, skipping`,
		);
		return undefined;
	}
}

function loadMcpConfigFromPaths(
	configPaths: string | string[] | undefined,
): Record<string, McpServerConfig> {
	if (!configPaths) return {};

	const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
	let mcpServers: Record<string, McpServerConfig> = {};

	for (const configPath of paths) {
		try {
			const content = readFileSync(configPath, "utf8");
			const parsed = JSON.parse(content) as {
				mcpServers?: Record<string, McpServerConfig>;
			};
			const servers =
				parsed?.mcpServers && typeof parsed.mcpServers === "object"
					? parsed.mcpServers
					: {};
			mcpServers = { ...mcpServers, ...servers };
			console.log(
				`[GrokRunner] Loaded MCP config from ${configPath}: ${Object.keys(servers).join(", ") || "(none)"}`,
			);
		} catch (error) {
			console.warn(
				`[GrokRunner] Failed to load MCP config from ${configPath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return mcpServers;
}

export interface McpTranslateOptions {
	workingDirectory?: string;
	mcpConfigPath?: string | string[];
	mcpConfig?: Record<string, McpServerConfig>;
	/** From initialize agentCapabilities.mcpCapabilities */
	mcpCapabilities?: AcpMcpCapabilities;
}

/**
 * Build ACP mcpServers list from Cyrus config (paths + inline).
 * Wire shape matches ACP:
 * - env: [{ name, value }]
 * - headers: [{ name, value }]
 * - args: string[] (required for stdio)
 */
export function translateMcpConfigToAcp(
	options: McpTranslateOptions | Record<string, McpServerConfig> | undefined,
): AcpMcpServer[] {
	// Back-compat: old call site passed raw mcpConfig record
	const opts: McpTranslateOptions =
		options &&
		typeof options === "object" &&
		("mcpConfig" in options ||
			"mcpConfigPath" in options ||
			"workingDirectory" in options ||
			"mcpCapabilities" in options)
			? (options as McpTranslateOptions)
			: { mcpConfig: options as Record<string, McpServerConfig> | undefined };

	const autoPath = autoDetectMcpConfigPath(opts.workingDirectory);
	const pathConfigs = loadMcpConfigFromPaths(
		opts.mcpConfigPath
			? Array.isArray(opts.mcpConfigPath)
				? autoPath
					? [...opts.mcpConfigPath, autoPath]
					: opts.mcpConfigPath
				: autoPath
					? [opts.mcpConfigPath, autoPath]
					: opts.mcpConfigPath
			: autoPath,
	);

	// Inline overrides paths
	const merged: Record<string, McpServerConfig> = {
		...pathConfigs,
		...(opts.mcpConfig || {}),
	};

	// ACP: HTTP/SSE only when the agent advertises them (false or absent = unsupported).
	// Stdio is always allowed. Match both transports with the same opt-in rule.
	const httpSupported = opts.mcpCapabilities?.http === true;
	const sseSupported = opts.mcpCapabilities?.sse === true;

	const servers: AcpMcpServer[] = [];

	for (const [name, raw] of Object.entries(merged)) {
		const cfg = raw as Record<string, unknown>;

		if (
			typeof cfg.listTools === "function" ||
			typeof cfg.callTool === "function"
		) {
			console.warn(
				`[GrokRunner] Skipping MCP server '${name}': in-process SDK servers cannot be passed to Grok ACP`,
			);
			continue;
		}

		if (typeof cfg.url === "string" && cfg.url.length > 0) {
			const type = cfg.type === "sse" ? "sse" : "http";
			if (type === "http" && !httpSupported) {
				console.warn(
					`[GrokRunner] Skipping MCP server '${name}': agent does not advertise mcpCapabilities.http`,
				);
				continue;
			}
			if (type === "sse" && !sseSupported) {
				console.warn(
					`[GrokRunner] Skipping MCP server '${name}': agent does not advertise mcpCapabilities.sse`,
				);
				continue;
			}

			const headersRecord =
				cfg.headers &&
				typeof cfg.headers === "object" &&
				!Array.isArray(cfg.headers)
					? (cfg.headers as Record<string, string>)
					: undefined;

			servers.push({
				name,
				type,
				url: cfg.url,
				headers: recordToNameValueList(headersRecord),
			});
			continue;
		}

		if (typeof cfg.command === "string" && cfg.command.length > 0) {
			const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
			const envRecord =
				cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
					? (cfg.env as Record<string, string>)
					: undefined;
			servers.push({
				name,
				command: cfg.command,
				args,
				env: recordToNameValueList(envRecord),
			});
			continue;
		}

		console.warn(
			`[GrokRunner] Skipping MCP server '${name}': no serializable command/url transport`,
		);
	}

	return servers;
}

/** Test helper: convert a plain record to ACP name/value list */
export function toAcpNameValueList(
	record: Record<string, string> | undefined,
): AcpNameValue[] {
	return recordToNameValueList(record);
}
