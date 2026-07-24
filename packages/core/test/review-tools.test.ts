import { describe, expect, it } from "vitest";
import {
	LINEAR_DEFAULT_ALLOWED_TOOLS,
	REVIEW_ALLOWED_TOOLS,
	REVIEW_DISALLOWED_TOOLS,
} from "../src/allowed-tools-defaults.js";

/**
 * The `reviewOnStatus` review session must be read-only *by construction* —
 * the prompt asking it not to edit code is not the control that matters here.
 */
describe("REVIEW_ALLOWED_TOOLS", () => {
	const allowed = [...REVIEW_ALLOWED_TOOLS] as string[];

	it("grants no code-writing tool", () => {
		for (const writeTool of ["Edit", "Write", "NotebookEdit"]) {
			expect(allowed).not.toContain(writeTool);
			expect(allowed.some((t) => t.startsWith(`${writeTool}(`))).toBe(false);
		}
	});

	it("grants no general Bash", () => {
		expect(allowed).not.toContain("Bash");
	});

	it("grants only read-only git/gh shell commands", () => {
		const shellTools = allowed.filter((tool) => tool.startsWith("Bash("));
		expect(shellTools.length).toBeGreaterThan(0);

		const readOnlyCommands = [
			"git diff",
			"git log",
			"git show",
			"git status",
			"git blame",
			"gh pr view",
			"gh pr diff",
		];
		for (const tool of shellTools) {
			const command = tool.slice("Bash(".length, -":*)".length);
			expect(readOnlyCommands).toContain(command);
		}
	});

	it("can read the diff", () => {
		expect(allowed).toContain("Read");
		expect(allowed).toContain("Bash(git diff:*)");
	});

	it("keeps mcp__linear so the review can be posted", () => {
		expect(allowed).toContain("mcp__linear");
	});

	it("is tighter than the full Linear session toolset", () => {
		expect(allowed.length).toBeLessThan(LINEAR_DEFAULT_ALLOWED_TOOLS.length);
	});
});

describe("REVIEW_DISALLOWED_TOOLS", () => {
	const disallowed = [...REVIEW_DISALLOWED_TOOLS] as string[];

	it("denies every file-writing tool outright", () => {
		expect(disallowed).toContain("Edit");
		expect(disallowed).toContain("Write");
		expect(disallowed).toContain("NotebookEdit");
	});

	it("denies commands that would publish or alter the branch", () => {
		expect(disallowed).toContain("Bash(git push:*)");
		expect(disallowed).toContain("Bash(git commit:*)");
		expect(disallowed).toContain("Bash(gh pr merge:*)");
	});

	it("does not deny anything the review needs", () => {
		for (const tool of REVIEW_ALLOWED_TOOLS) {
			expect(disallowed).not.toContain(tool);
		}
	});
});
