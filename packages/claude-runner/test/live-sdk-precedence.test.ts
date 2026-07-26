import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveBuiltInDisallowedTools } from "../src/built-in-tool-restrictions";

/**
 * CYR-25 — the crux, exercised against the REAL SDK.
 *
 * Everything else in this package's suite runs against a mocked `query`, which
 * can only prove that Cyrus *emits* the right flags. It cannot prove the claim
 * the whole ticket rests on: that a `disallowedTools` entry actually refuses a
 * command some layer above `canUseTool` would otherwise permit. This project
 * has been wrong about a guardrail five times, each time caught only by running
 * something, so that claim is measured here rather than assumed.
 *
 * These tests spawn the real Claude Code binary and make real model calls, so
 * they are opt-in:
 *
 *     CYRUS_LIVE_SDK_TEST=1 pnpm vitest run test/live-sdk-precedence.test.ts
 *
 * ## What was measured (2026-07-26, @anthropic-ai/claude-agent-sdk@0.3.205)
 *
 * | run       | config                                    | `git status` | canUseTool fired |
 * |-----------|-------------------------------------------|--------------|------------------|
 * | control   | no deny rules                             | **allowed**  | no               |
 * | treatment | + `Bash(git status:*)` in disallowedTools | **denied**   | no               |
 *
 * The control reproduces the production behaviour seen live on CYR-23/CYR-27:
 * a session whose only shell grant is `Bash(git -C * pull)` runs `git status`
 * anyway. The cause is `sandbox.autoAllowBashIfSandboxed` — Cyrus enables the
 * SDK sandbox, and the SDK auto-approves commands its own read-only classifier
 * recognises *before* consulting `canUseTool`. It is NOT settings-file
 * shadowing, which was ruled out separately.
 *
 * The treatment differs by one array entry and flips the outcome, with the
 * SDK's own rule-engine message. So: deny beats the pre-approval layer, and it
 * short-circuits ahead of `canUseTool` too (the callback never fired).
 */
const LIVE = process.env.CYRUS_LIVE_SDK_TEST === "1";

describe.runIf(LIVE)(
	"disallowedTools vs. the SDK pre-approval layer (live)",
	() => {
		let repo: string;

		beforeAll(() => {
			repo = mkdtempSync(join(tmpdir(), "cyrus-cyr25-"));
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["-C", repo, "config", "user.email", "t@t.co"]);
			execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
			writeFileSync(join(repo, "a.txt"), "hello\n");
			execFileSync("git", ["-C", repo, "add", "-A"]);
			execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
		});

		afterAll(() => {
			rmSync(repo, { recursive: true, force: true });
		});

		/**
		 * Ask the real SDK to run one command and report how it was resolved.
		 *
		 * `canUseTool` denies everything, mirroring a Cyrus session whose grants do
		 * not cover the command. So an "allowed" outcome can only mean some layer
		 * above the callback approved it.
		 */
		async function runCommand(options: {
			command: string;
			disallowedTools: string[];
			sandbox: boolean;
		}): Promise<{ callbackFired: boolean; results: string[] }> {
			const results: string[] = [];
			let callbackFired = false;

			const q = query({
				prompt: `In this repo, please run: ${options.command}`,
				options: {
					cwd: repo,
					model: "claude-haiku-4-5-20251001",
					maxTurns: 2,
					// The only Bash grant a readOnly Slack persona gets is
					// `Bash(git -C * pull)`, and ClaudeRunner strips Bash entries from
					// what the SDK sees so nothing is auto-approved via allowedTools.
					allowedTools: ["Read", "Glob", "Grep"],
					disallowedTools: options.disallowedTools,
					tools: ["Read", "Glob", "Grep", "Bash"],
					settingSources: ["user", "project", "local"],
					...(options.sandbox && {
						sandbox: {
							enabled: true,
							autoAllowBashIfSandboxed: true,
							failIfUnavailable: false,
						},
					}),
					canUseTool: async () => {
						callbackFired = true;
						return {
							behavior: "deny" as const,
							message: "CYRUS-CALLBACK-DENY",
						};
					},
				},
			});

			try {
				for await (const msg of q) {
					if (msg.type === "user") {
						for (const block of (msg as any).message?.content ?? []) {
							if (block.type === "tool_result") {
								results.push(
									typeof block.content === "string"
										? block.content
										: JSON.stringify(block.content),
								);
							}
						}
					}
				}
			} catch {
				// maxTurns exhaustion throws; the tool results gathered so far are
				// what we are asserting on.
			}

			return { callbackFired, results };
		}

		it("control: the sandbox pre-approves git status before canUseTool is consulted", async () => {
			const { callbackFired, results } = await runCommand({
				command: "git status",
				disallowedTools: [],
				sandbox: true,
			});

			// Reproduces the production bug: the command ran despite a callback
			// that denies everything, and the callback was never asked.
			expect(results.join("\n")).toContain("On branch");
			expect(callbackFired).toBe(false);
		}, 180_000);

		it("treatment: a deny rule refuses the very command the sandbox pre-approved", async () => {
			const { results } = await runCommand({
				command: "git status",
				disallowedTools: ["Bash(git status:*)"],
				sandbox: true,
			});

			// One array entry different from the control, opposite outcome, and
			// the refusal comes from the SDK's rule engine rather than from us.
			const joined = results.join("\n");
			expect(joined).toContain("has been denied");
			expect(joined).not.toContain("On branch");
		}, 180_000);

		it("a derived deny rule blocks an in-place write, including through a chain", async () => {
			// `sed -i` is the way around a denied Edit, and chaining is the way
			// around a matcher that only inspects the head of a command. The SDK
			// evaluates deny rules against every link, so both are refused.
			const denied = deriveBuiltInDisallowedTools(["Read", "Glob", "Grep"]);
			expect(denied).toContain("Bash(sed:*)");

			writeFileSync(join(repo, "a.txt"), "hello\n");
			const { results } = await runCommand({
				command: "sed -i '' 's/hello/pwned/' a.txt && cat a.txt",
				disallowedTools: denied,
				sandbox: false,
			});

			expect(results.join("\n")).toContain("has been denied");
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
		}, 180_000);

		it("a deny rule outranks a permissive permissions.allow rule in a settings file", async () => {
			// The SDK warns that settings-file allow rules can shadow canUseTool
			// invisibly. Cyrus passes settingSources: ["user","project","local"],
			// so a repo's own `.claude/settings.local.json` is live. Plant the
			// most permissive rule possible and confirm the deny still wins.
			mkdirSync(join(repo, ".claude"), { recursive: true });
			writeFileSync(
				join(repo, ".claude", "settings.local.json"),
				JSON.stringify({
					permissions: { allow: ["Bash", "Bash(sed:*)", "Write", "Edit"] },
				}),
			);
			writeFileSync(join(repo, "a.txt"), "hello\n");

			const { results } = await runCommand({
				command: "sed -i '' 's/hello/pwned/' a.txt",
				disallowedTools: deriveBuiltInDisallowedTools(["Read", "Glob", "Grep"]),
				sandbox: false,
			});

			expect(results.join("\n")).toContain("has been denied");
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
		}, 180_000);
	},
);
