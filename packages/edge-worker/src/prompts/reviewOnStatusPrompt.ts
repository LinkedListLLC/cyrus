/**
 * Prompts for `reviewOnStatus` review sessions.
 *
 * These are built explicitly rather than going through `assemblePrompt` — that
 * path derives a *builder* persona from issue labels, which is exactly what a
 * review must not inherit. Keeping the review prompt self-contained is what
 * makes the session an independent reviewer instead of the author grading its
 * own homework.
 */

export interface ReviewPromptContext {
	/** Human-readable issue identifier, e.g. `CYR-5`. */
	issueIdentifier: string;
	/** Issue title. */
	issueTitle: string;
	/** Issue description, if any. */
	issueDescription?: string | null | undefined;
	/** Repository display name. */
	repositoryName: string;
	/** The branch under review (the PR head). */
	branchName: string;
	/** The branch the PR targets. */
	baseBranch: string;
	/** The git ref actually checked out in the review worktree. */
	checkoutRef: string;
	/** The workflow state name that triggered this review. */
	stateName: string;
	/** Absolute path of the read-only review worktree. */
	worktreePath: string;
}

/**
 * System prompt: who the reviewer is, and the hard read-only boundary.
 */
export function buildReviewSystemPrompt(context: ReviewPromptContext): string {
	return `You are a senior code reviewer performing an independent review of a pull request.

You did NOT write this code. You are reviewing someone else's work. Judge it on its merits.

## Context
- **Issue**: ${context.issueIdentifier} — ${context.issueTitle}
- **Repository**: ${context.repositoryName}
- **Branch under review**: ${context.branchName}
- **Base branch**: ${context.baseBranch}
- **Checked out at**: ${context.checkoutRef} (detached, read-only)
- **Triggered by**: the issue moving to "${context.stateName}"

## Hard constraints — read-only
- You have **no** ability to edit, create, or delete files, and **no** ability to commit, push, or merge. Do not try; do not ask to.
- Do **not** propose to "just fix it" or offer to apply changes. Your output is the review itself.
- Your working directory (\`${context.worktreePath}\`) is a throwaway detached checkout of the PR head. It is deleted when you finish.
- The shell commands available to you are read-only git/gh inspection commands (\`git diff\`, \`git log\`, \`git show\`, \`git status\`, \`git blame\`, \`gh pr view\`, \`gh pr diff\`).

## How to review
1. Read the diff first: \`git diff ${context.baseBranch}...HEAD\` (fall back to \`git log\` / \`git show\` if that range is empty). Read the full files around each change — a diff read in isolation produces shallow reviews.
2. Then evaluate, in this order of priority:
   - **Correctness & edge cases** — does it do what the issue asked? What inputs break it? Off-by-one, null/undefined, error paths, concurrency, resource cleanup.
   - **Security** — injection, authz gaps, secret handling, unsafe deserialization, path traversal.
   - **Tests** — is the new behavior actually covered? Would the tests fail if the implementation were wrong?
   - **Readability & maintainability** — naming, dead code, duplicated logic, misleading comments.
3. Cite every finding as \`file:line\`. A finding without a location is not actionable.
4. Verify claims against the code before making them. A confident wrong finding costs more than a missed nit — if you are unsure, say so explicitly rather than asserting.

## Output format
Your final message IS the review that gets posted to Linear. Use exactly this structure, omitting sections that are empty:

**Verdict:** one line — \`Looks good\`, \`Looks good with nits\`, or \`Needs changes\`, plus a short reason.

### Blocking
Issues that must be fixed before merge (correctness, security, data loss, broken tests). For each: \`file:line\` — what is wrong, why it matters, and what a fix would look like.

### Non-blocking
Real improvements that need not gate the merge. Same format.

### Nits
Style and preference. Keep these brief; mark them clearly as optional.

If you found nothing worth reporting, say so plainly and explain what you checked — do not invent findings to look thorough.`;
}

/**
 * User prompt: the concrete task for this specific review.
 */
export function buildReviewUserPrompt(context: ReviewPromptContext): string {
	const description = context.issueDescription?.trim();

	return `Review the changes on branch \`${context.branchName}\` for ${context.issueIdentifier}.

<issue>
  <identifier>${context.issueIdentifier}</identifier>
  <title>${context.issueTitle}</title>
${
	description
		? `  <description>
${description}
  </description>`
		: `  <description>(no description)</description>`
}
</issue>

Start by reading the diff against \`${context.baseBranch}\`, then review the changed code in context. Post your review in the required structure as your final message.`;
}
