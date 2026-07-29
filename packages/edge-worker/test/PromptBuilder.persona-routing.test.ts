import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/PromptBuilder.js";

/**
 * Persona routing, exercised against the **real** `prompts/*.md` files on disk
 * rather than a mocked `readFile`.
 *
 * That distinction is the point of this file. `EdgeWorker.dynamic-tools.test.ts`
 * mocks the filesystem, so it proves the label → prompt-type mapping but would
 * happily pass if a prompt file were missing, renamed, or stripped of its
 * version tag — which is exactly how `scoper.md` shipped without one for
 * several releases, silently logging no `systemPromptVersion` on every scoper
 * session.
 */

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeBuilder(): PromptBuilder {
	return new PromptBuilder({
		logger: noopLogger,
		repositories: new Map(),
		issueTrackers: new Map(),
		gitService: {} as never,
	});
}

function makeRepository(
	labelPrompts: RepositoryConfig["labelPrompts"],
): RepositoryConfig {
	return {
		id: "repo-1",
		name: "cyrus",
		repositoryPath: "/tmp/cyrus",
		baseBranch: "main",
		workspaceBaseDir: "/tmp/cyrus-workspaces",
		labelPrompts,
	} as RepositoryConfig;
}

/** The label→persona config the Wayfinder routing is meant to be deployed with. */
const WAYFINDER_LABEL_PROMPTS: RepositoryConfig["labelPrompts"] = {
	wayfinder: {
		labels: ["wayfinder:map", "wayfinder:research", "wayfinder:grilling"],
		allowedTools: "readOnly",
	},
	"wayfinder-task": {
		labels: ["wayfinder:task", "wayfinder:prototype"],
		allowedTools: "safe",
	},
	debugger: { labels: ["Bug"] },
	builder: { labels: ["Feature"] },
	scoper: { labels: ["Scoper"] },
};

describe("PromptBuilder — Wayfinder persona routing", () => {
	it("routes the three read-only wayfinder labels to prompts/wayfinder.md", async () => {
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);
		const onDisk = await readFile(join(PROMPTS_DIR, "wayfinder.md"), "utf-8");

		for (const label of [
			"wayfinder:research",
			"wayfinder:grilling",
			"wayfinder:map",
		]) {
			const result = await builder.determineSystemPromptFromLabels(
				[label],
				[repository],
			);

			expect(result?.type, `label ${label}`).toBe("wayfinder");
			expect(result?.prompt).toBe(onDisk);
			expect(result?.version).toBe("wayfinder-v1.0.0");
		}
	});

	it("routes the two write wayfinder labels to prompts/wayfinder-task.md", async () => {
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);
		const onDisk = await readFile(
			join(PROMPTS_DIR, "wayfinder-task.md"),
			"utf-8",
		);

		for (const label of ["wayfinder:task", "wayfinder:prototype"]) {
			const result = await builder.determineSystemPromptFromLabels(
				[label],
				[repository],
			);

			expect(result?.type, `label ${label}`).toBe("wayfinder-task");
			expect(result?.prompt).toBe(onDisk);
			expect(result?.version).toBe("wayfinder-task-v1.0.0");
		}
	});

	it("prefers wayfinder over debugger when an issue carries both labels", async () => {
		// The ordering guarantee in `matchSystemPromptForRepo`'s `promptTypes`
		// array. A research question *about* a bug is still research — if
		// `debugger` won, the session would arrive with write tools and an
		// instruction to ship a fix.
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		const result = await builder.determineSystemPromptFromLabels(
			["Bug", "wayfinder:research"],
			[repository],
		);

		expect(result?.type).toBe("wayfinder");
	});

	it("prefers wayfinder-task over builder when an issue carries both labels", async () => {
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		const result = await builder.determineSystemPromptFromLabels(
			["Feature", "wayfinder:prototype"],
			[repository],
		);

		expect(result?.type).toBe("wayfinder-task");
	});

	it("leaves non-wayfinder routing untouched", async () => {
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		await expect(
			builder
				.determineSystemPromptFromLabels(["Bug"], [repository])
				.then((r) => r?.type),
		).resolves.toBe("debugger");
		await expect(
			builder
				.determineSystemPromptFromLabels(["Feature"], [repository])
				.then((r) => r?.type),
		).resolves.toBe("builder");
		await expect(
			builder
				.determineSystemPromptFromLabels(["Scoper"], [repository])
				.then((r) => r?.type),
		).resolves.toBe("scoper");
	});

	it("prefers scoper over debugger and builder when an issue carries both", async () => {
		// The ordering comment states a principle — a label describing *how the
		// session must behave* beats one describing the subject matter — and
		// `scoper` is read-only and plan-only, so the principle covers it. The
		// array put it after `debugger` and `builder` anyway, so a ticket labelled
		// both `Bug` and a scoper label started building instead of scoping.
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		await expect(
			builder
				.determineSystemPromptFromLabels(["Bug", "Scoper"], [repository])
				.then((r) => r?.type),
		).resolves.toBe("scoper");
		await expect(
			builder
				.determineSystemPromptFromLabels(["Feature", "Scoper"], [repository])
				.then((r) => r?.type),
		).resolves.toBe("scoper");
	});

	it("still prefers wayfinder over scoper", async () => {
		// Wayfinder stays the most constraining: one ticket, never self-answer.
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		const result = await builder.determineSystemPromptFromLabels(
			["Scoper", "wayfinder:research"],
			[repository],
		);

		expect(result?.type).toBe("wayfinder");
	});

	it("matches wayfinder labels case-insensitively", async () => {
		const builder = makeBuilder();
		const repository = makeRepository(WAYFINDER_LABEL_PROMPTS);

		const result = await builder.determineSystemPromptFromLabels(
			["Wayfinder:Research"],
			[repository],
		);

		expect(result?.type).toBe("wayfinder");
	});
});

describe("prompts/*.md — every persona prompt declares a version", () => {
	it("parses a <version-tag> out of every prompt file", async () => {
		const files = (await readdir(PROMPTS_DIR))
			.filter((f) => f.endsWith(".md"))
			// The two templates are prompt *fragments* interpolated into a larger
			// prompt, not personas, so they carry no version of their own.
			.filter(
				(f) =>
					f !== "standard-issue-assigned-user-prompt.md" &&
					f !== "todolist-system-prompt-extension.md",
			);

		// Guard against the filter silently matching nothing.
		expect(files.length).toBeGreaterThanOrEqual(7);

		for (const file of files) {
			const content = await readFile(join(PROMPTS_DIR, file), "utf-8");
			const match = content.match(/<version-tag value="([^"]+)"\s*\/>/);

			expect(match, `${file} has no <version-tag>`).not.toBeNull();
			// The version must name its own persona, so a copy-pasted prompt
			// cannot report another persona's version.
			expect(match?.[1], `${file} version tag`).toMatch(
				new RegExp(`^${file.replace(/\.md$/, "")}-v\\d+\\.\\d+\\.\\d+$`),
			);
		}
	});
});
