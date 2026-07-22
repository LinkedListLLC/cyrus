import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
	JsonRpcId,
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
} from "./acpTypes.js";

type Pending = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type AcpClientOptions = {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Default request timeout in ms */
	requestTimeoutMs?: number;
	onNotification?: (notification: JsonRpcNotification) => void;
	/**
	 * Handle agent → client JSON-RPC requests (messages with both `id` and `method`).
	 * Return a result object, or throw / return null to send a method-not-found error.
	 * Default: auto-approve `session/request_permission`, reject everything else.
	 */
	onAgentRequest?: (
		method: string,
		params: unknown,
	) => Promise<unknown> | unknown;
	onStderr?: (chunk: string) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

/**
 * Minimal JSON-RPC 2.0 client over a child process stdio (one JSON object per line).
 *
 * Important: ACP is bidirectional. The agent may send *requests* to the client
 * (e.g. `session/request_permission`) with both `id` and `method`. Those must
 * not be treated as responses to our pending calls.
 */
export class AcpClient {
	private proc: ChildProcess | null = null;
	private readline: Interface | null = null;
	private nextId = 1;
	private pending = new Map<JsonRpcId, Pending>();
	private closed = false;
	private readonly options: AcpClientOptions;

	constructor(options: AcpClientOptions) {
		this.options = options;
	}

	start(): void {
		if (this.proc) {
			throw new Error("AcpClient already started");
		}

		this.proc = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.on("error", (err) => {
			this.failAll(err);
		});

		this.proc.on("exit", (code, signal) => {
			this.closed = true;
			this.failAll(
				new Error(
					`Grok ACP process exited (code=${code}, signal=${signal ?? "none"})`,
				),
			);
			this.options.onExit?.(code, signal);
		});

		if (this.proc.stderr) {
			this.proc.stderr.setEncoding("utf8");
			this.proc.stderr.on("data", (chunk: string) => {
				this.options.onStderr?.(chunk);
			});
		}

		if (!this.proc.stdout) {
			throw new Error("Grok ACP process has no stdout");
		}

		this.readline = createInterface({
			input: this.proc.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		this.readline.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(trimmed) as JsonRpcMessage;
			} catch {
				console.warn(
					`[AcpClient] Ignoring non-JSON stdout line: ${trimmed.slice(0, 200)}`,
				);
				return;
			}
			void this.handleMessage(msg);
		});
	}

	async request(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<unknown> {
		if (!this.proc?.stdin || this.closed) {
			throw new Error(`Cannot send ACP request ${method}: process not running`);
		}

		const id = this.nextId++;
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(params !== undefined ? { params } : {}),
		};

		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120_000;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ACP request timed out: ${method}`));
			}, timeout);

			this.pending.set(id, {
				resolve,
				reject,
				timer,
			});

			const payload = `${JSON.stringify(request)}\n`;
			this.proc?.stdin?.write(payload, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	/**
	 * Send a JSON-RPC response to an agent-initiated request.
	 */
	respond(id: JsonRpcId, result: unknown): void {
		if (!this.proc?.stdin || this.closed) return;
		const payload = `${JSON.stringify({
			jsonrpc: "2.0",
			id,
			result,
		})}\n`;
		this.proc.stdin.write(payload);
	}

	respondError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		if (!this.proc?.stdin || this.closed) return;
		const payload = `${JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data !== undefined ? { data } : {}) },
		})}\n`;
		this.proc.stdin.write(payload);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.proc && !this.closed) {
			this.proc.kill(signal);
		}
		this.cleanup();
	}

	isRunning(): boolean {
		return Boolean(this.proc && !this.closed);
	}

	private async handleMessage(msg: JsonRpcMessage): Promise<void> {
		const record = msg as unknown as Record<string, unknown>;
		const hasId =
			"id" in record && record.id !== undefined && record.id !== null;
		const hasMethod = "method" in record && typeof record.method === "string";
		const hasResultOrError = "result" in record || "error" in record;

		// Agent → client request: both id and method, not a response
		if (hasId && hasMethod && !hasResultOrError) {
			const id = record.id as JsonRpcId;
			const method = record.method as string;
			const params = record.params;
			try {
				const result = await this.dispatchAgentRequest(method, params);
				this.respond(id, result);
			} catch (err) {
				this.respondError(
					id,
					-32603,
					err instanceof Error ? err.message : String(err),
				);
			}
			return;
		}

		// Response to one of our requests
		if (hasId && hasResultOrError) {
			const response = msg as JsonRpcResponse;
			const pending = this.pending.get(response.id);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(response.id);
			if (response.error) {
				pending.reject(
					new Error(
						response.error.message ||
							`ACP error ${response.error.code ?? "unknown"}`,
					),
				);
			} else {
				pending.resolve(response.result);
			}
			return;
		}

		// Notification (method, no id)
		if (hasMethod && !hasId) {
			this.options.onNotification?.(msg as JsonRpcNotification);
		}
	}

	private async dispatchAgentRequest(
		method: string,
		params: unknown,
	): Promise<unknown> {
		if (this.options.onAgentRequest) {
			const custom = await this.options.onAgentRequest(method, params);
			if (custom !== undefined) {
				return custom;
			}
		}
		return defaultHandleAgentRequest(method, params);
	}

	private failAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private cleanup(): void {
		this.closed = true;
		this.readline?.close();
		this.readline = null;
		this.proc = null;
		this.failAll(new Error("ACP client closed"));
	}
}

/**
 * Default handlers for reverse RPC from the Grok agent.
 * Auto-approves permissions (edge workers are unattended).
 */
export function defaultHandleAgentRequest(
	method: string,
	params: unknown,
): unknown {
	if (
		method === "session/request_permission" ||
		method.endsWith("/request_permission")
	) {
		return autoApprovePermission(params);
	}

	// Do not advertise fs/terminal capabilities — if agent still asks, cancel safely.
	if (method.startsWith("fs/") || method.startsWith("terminal/")) {
		throw new Error(
			`Client capability not implemented: ${method}. Do not advertise fs/terminal in initialize.`,
		);
	}

	throw new Error(`Unsupported agent→client method: ${method}`);
}

function autoApprovePermission(params: unknown): unknown {
	const p = (params || {}) as {
		options?: Array<{
			optionId?: string;
			option_id?: string;
			kind?: string;
			name?: string;
		}>;
	};
	const options = Array.isArray(p.options) ? p.options : [];

	const allow =
		options.find((o) => {
			const kind = (o.kind || "").toLowerCase();
			const name = (o.name || "").toLowerCase();
			return (
				kind === "allowonce" ||
				kind === "allow_always" ||
				kind === "allowalways" ||
				kind === "allow" ||
				name.includes("allow")
			);
		}) || options[0];

	const optionId = allow?.optionId || allow?.option_id;
	if (optionId) {
		return {
			outcome: {
				outcome: "selected",
				optionId,
			},
		};
	}

	// No options advertised — cancel rather than hang
	return {
		outcome: {
			outcome: "cancelled",
		},
	};
}
