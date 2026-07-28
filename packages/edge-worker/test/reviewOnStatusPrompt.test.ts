import { describe, expect, it } from "vitest";
import {
	buildReviewSystemPrompt,
	buildReviewUserPrompt,
	type ReviewPromptContext,
} from "../src/prompts/reviewOnStatusPrompt.js";

const context: ReviewPromptContext = {
	issueIdentifier: "CYR-5",
	issueTitle: "Add reviewOnStatus",
	issueDescription: "Start a read-only review when the issue moves to review.",
	repositoryName: "cyrus",
	branchName: "william/cyr-5-reviewonstatus",
	baseBranch: "main",
	checkoutRef: "origin/william/cyr-5-reviewonstatus",
	stateName: "In Review",
	worktreePath: "/tmp/worktrees/reviews/CYR-5-abcd1234",
};

describe("buildReviewSystemPrompt", () => {
	const prompt = buildReviewSystemPrompt(context);

	it("frames the session as an independent reviewer, not the author", () => {
		expect(prompt).toContain("You did NOT write this code");
	});

	it("states the read-only boundary", () => {
		expect(prompt).toContain("Hard constraints — read-only");
		expect(prompt).toContain(
			"**no** ability to edit, create, or delete files, and **no** ability to commit, push, or merge",
		);
		expect(prompt).toContain('Do **not** propose to "just fix it"');
	});

	it("names the branch, base branch, checkout and trigger state", () => {
		expect(prompt).toContain(context.branchName);
		expect(prompt).toContain(context.baseBranch);
		expect(prompt).toContain(context.checkoutRef);
		expect(prompt).toContain(context.stateName);
		expect(prompt).toContain(context.worktreePath);
	});

	it("specifies the structured output contract", () => {
		expect(prompt).toContain("**Verdict:**");
		expect(prompt).toContain("### Blocking");
		expect(prompt).toContain("### Non-blocking");
		expect(prompt).toContain("### Nits");
	});

	it("orders the review priorities and requires file:line citations", () => {
		const correctness = prompt.indexOf("Correctness & edge cases");
		const security = prompt.indexOf("**Security**");
		const tests = prompt.indexOf("**Tests**");
		const readability = prompt.indexOf("**Readability & maintainability**");

		expect(correctness).toBeGreaterThan(-1);
		expect(security).toBeGreaterThan(correctness);
		expect(tests).toBeGreaterThan(security);
		expect(readability).toBeGreaterThan(tests);
		expect(prompt).toContain("`file:line`");
	});

	it("does not invite the reviewer to invent findings", () => {
		expect(prompt).toContain("do not invent findings");
	});
});

describe("buildReviewUserPrompt", () => {
	it("asks for a review of the branch and includes the issue", () => {
		const prompt = buildReviewUserPrompt(context);

		expect(prompt).toContain(context.branchName);
		expect(prompt).toContain("CYR-5");
		expect(prompt).toContain("Add reviewOnStatus");
		expect(prompt).toContain(context.issueDescription as string);
	});

	it("handles a missing description", () => {
		const prompt = buildReviewUserPrompt({
			...context,
			issueDescription: null,
		});

		expect(prompt).toContain("(no description)");
	});
});
