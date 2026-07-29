import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	classifyShell,
	deriveScenarios,
	type PersonaResult,
	parseArgs,
	warningsFor,
} from "./PersonasCommand.js";

function makeResult(overrides: Partial<PersonaResult> = {}): PersonaResult {
	return {
		repository: "cyrus",
		labels: ["wayfinder:task"],
		persona: "wayfinder-task",
		promptFile: "packages/edge-worker/prompts/wayfinder-task.md",
		version: "wayfinder-task-v1.0.0",
		missingVersionTag: false,
		allowedCount: 30,
		allowed: ["Read", "Edit", "Write", "Bash", "Task"],
		disallowed: [],
		effectiveTools: ["Bash", "Edit", "Glob", "Grep", "Read", "Task", "Write"],
		effectiveDisallowed: [],
		dropped: [],
		canWrite: true,
		shell: "full",
		...overrides,
	};
}

describe("classifyShell", () => {
	it("recognises an unrestricted Bash grant", () => {
		expect(classifyShell(["Read", "Bash", "Write"])).toBe("full");
	});

	it("recognises narrowed Bash(...) grants", () => {
		expect(classifyShell(["Read", "Bash(git log:*)"])).toBe("narrowed");
	});

	it("reports no shell when no Bash entry of any form is present", () => {
		expect(classifyShell(["Read", "Write", "Edit", "Task"])).toBe("none");
	});
});

describe("classifyShell agrees with the derivation, not just the config", () => {
	it("reports no shell when the derivation withheld Bash", () => {
		// `allowedTools` can name Bash while `deriveBuiltInTools` withholds it.
		// The config list is not the capability list.
		expect(classifyShell(["Read", "Bash"], ["Glob", "Grep", "Read"])).toBe(
			"none",
		);
	});

	it("keeps narrowed when the derivation kept Bash", () => {
		expect(
			classifyShell(
				["Read", "Bash(git log:*)"],
				["Bash", "Glob", "Grep", "Read"],
			),
		).toBe("narrowed");
	});

	it("treats Bash(*) as unrestricted rather than narrowed", () => {
		expect(classifyShell(["Read", "Bash(*)"], ["Bash", "Read"])).toBe("full");
		expect(classifyShell(["Read", "Bash(**)"], ["Bash", "Read"])).toBe("full");
	});
});

describe("canWrite is read off the effective toolset", () => {
	it("sees a write grant that carries an argument", () => {
		// `availableTools` ships `Edit(**)` and `Write(**)`, not the bare names,
		// so the old exact-equality check against `allowed` reported
		// `canWrite: false` for a repository configured
		// `["Read(**)","Edit(**)","Write(**)","Bash"]` — and the CYR-21 warning
		// this command was written for never fired. (`all` only reported true by
		// accident, because `NotebookEdit` happens to be listed bare.)
		const result = makeResult({
			allowed: ["Read(**)", "Edit(**)", "Write(**)", "Bash"],
			effectiveTools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"],
			canWrite: true,
		});
		expect(result.canWrite).toBe(true);
		expect(warningsFor(result)).toEqual([]);
	});
});

describe("warningsFor surfaces a grant the derivation dropped", () => {
	it("warns when a configured tool is not actually granted", () => {
		// `Edit(src/**)` reads as "may edit these paths". The narrowing is not
		// enforceable, so the derivation withholds `Edit` outright — a difference
		// between the config and the session that nothing used to report.
		const warnings = warningsFor(
			makeResult({
				allowed: ["Read", "Edit(src/**)", "Bash"],
				effectiveTools: ["Bash", "Glob", "Grep", "Read"],
				canWrite: false,
				shell: "full",
				dropped: [
					{
						entry: "Edit(src/**)",
						reason:
							"argument-narrowed grant on mutating tool cannot be enforced",
					},
				],
			}),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Edit(src/**)");
		expect(warnings[0]).toContain("configured but not granted");
	});
});

describe("warningsFor — the two defects this command exists to catch", () => {
	it("flags a persona that can write but has no shell (the CYR-21 `safe` trap)", () => {
		// This is the exact shape `allowedTools: "safe"` produces: every tool
		// except Bash. A session like this can edit files and then cannot run
		// the tests, the linter, git, or gh.
		const warnings = warningsFor(
			makeResult({
				allowed: ["Read", "Edit", "Write", "Task"],
				canWrite: true,
				shell: "none",
			}),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("NO shell");
		expect(warnings[0]).toContain("CYR-21");
	});

	it("flags a prompt file with no version tag (the scoper.md defect)", () => {
		const warnings = warningsFor(
			makeResult({ version: null, missingVersionTag: true }),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("<version-tag>");
		expect(warnings[0]).toContain("wayfinder-task.md");
	});

	it("reports both when both are wrong", () => {
		expect(
			warningsFor(
				makeResult({
					canWrite: true,
					shell: "none",
					version: null,
					missingVersionTag: true,
				}),
			),
		).toHaveLength(2);
	});

	it("stays quiet on a correctly configured write persona", () => {
		expect(warningsFor(makeResult())).toEqual([]);
	});

	it("stays quiet on a read-only persona with narrowed git grants", () => {
		expect(
			warningsFor(
				makeResult({
					persona: "wayfinder",
					promptFile: "packages/edge-worker/prompts/wayfinder.md",
					version: "wayfinder-v1.0.0",
					allowed: ["Read", "Grep", "Bash(git log:*)"],
					canWrite: false,
					shell: "narrowed",
				}),
			),
		).toEqual([]);
	});

	it("does not raise the shell warning for an unrouted issue", () => {
		// `persona: null` means no labelPrompts entry matched. There is no
		// persona to misconfigure, so a shell warning would be noise.
		expect(
			warningsFor(
				makeResult({
					persona: null,
					promptFile: null,
					version: null,
					allowed: ["Read"],
					canWrite: false,
					shell: "none",
				}),
			),
		).toEqual([]);
	});
});

describe("deriveScenarios", () => {
	const repo = (labelPrompts: unknown): RepositoryConfig =>
		({ id: "r", name: "r", labelPrompts }) as RepositoryConfig;

	it("derives one scenario per configured label, plus the no-label case", () => {
		const scenarios = deriveScenarios([
			repo({
				wayfinder: { labels: ["wayfinder:map", "wayfinder:research"] },
				"wayfinder-task": { labels: ["wayfinder:task"] },
			}),
		]);

		expect(scenarios).toEqual([
			["wayfinder:map"],
			["wayfinder:research"],
			["wayfinder:task"],
			[],
		]);
	});

	it("supports the legacy bare-array labelPrompts shape", () => {
		expect(deriveScenarios([repo({ debugger: ["Bug"] })])).toEqual([
			["Bug"],
			[],
		]);
	});

	it("dedupes labels shared across repositories", () => {
		const scenarios = deriveScenarios([
			repo({ debugger: { labels: ["Bug"] } }),
			repo({ debugger: { labels: ["Bug"] }, builder: { labels: ["Feature"] } }),
		]);

		expect(scenarios).toEqual([["Bug"], ["Feature"], []]);
	});

	it("returns only the no-label case when nothing is configured", () => {
		expect(deriveScenarios([repo(undefined)])).toEqual([[]]);
	});
});

describe("parseArgs", () => {
	it("distinguishes 'no labels given' from 'an issue with no labels'", () => {
		// The distinction is load-bearing: `undefined` means "print the whole
		// matrix", while `[]` is a real scenario the matrix includes.
		expect(parseArgs([]).labels).toBeUndefined();
		expect(parseArgs(["Bug"]).labels).toEqual(["Bug"]);
	});

	it("splits and trims a comma-separated label list", () => {
		expect(parseArgs(["Bug, wayfinder:research"]).labels).toEqual([
			"Bug",
			"wayfinder:research",
		]);
	});

	it("drops empty segments so a trailing comma is harmless", () => {
		expect(parseArgs(["Bug,"]).labels).toEqual(["Bug"]);
	});

	it("accepts --repo in both spaced and = forms", () => {
		expect(parseArgs(["--repo", "cyrus"]).repoFilter).toBe("cyrus");
		expect(parseArgs(["--repo=cyrus"]).repoFilter).toBe("cyrus");
	});

	it("does not mistake a flag value for a positional label list", () => {
		const parsed = parseArgs(["--repo", "cyrus", "--json"]);
		expect(parsed.labels).toBeUndefined();
		expect(parsed.repoFilter).toBe("cyrus");
		expect(parsed.json).toBe(true);
	});
});
