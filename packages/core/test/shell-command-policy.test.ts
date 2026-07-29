import { describe, expect, it } from "vitest";
import { REVIEW_ALLOWED_TOOLS } from "../src/allowed-tools-defaults.js";
import {
	commandMatchesAllowedBash,
	compileBashPattern,
	grantsUnrestrictedBash,
	hasBashGrant,
	scanShellCommand,
	splitShellCommands,
} from "../src/shell-command-policy.js";

/**
 * The review of PR #24 reproduced three ways for a session holding only
 * read-only shell grants to write a file. Each `it` below is one of those
 * reproductions, run against `REVIEW_ALLOWED_TOOLS` verbatim so the test fails
 * if the shipped preset regains the hole.
 */
const REVIEW = [...REVIEW_ALLOWED_TOOLS];

describe("commandMatchesAllowedBash — the read-only claim", () => {
	it("refuses a redirection that a prefix grant would otherwise match", () => {
		expect(
			commandMatchesAllowedBash("git diff HEAD > /root/.bashrc", REVIEW),
		).toBe(false);
		expect(commandMatchesAllowedBash("git log >> ~/.profile", REVIEW)).toBe(
			false,
		);
		expect(
			commandMatchesAllowedBash(
				"git show HEAD:package.json > pwned.txt",
				REVIEW,
			),
		).toBe(false);
	});

	it("refuses stream and here-doc redirections too", () => {
		expect(commandMatchesAllowedBash("git status 2>/dev/null", REVIEW)).toBe(
			false,
		);
		expect(commandMatchesAllowedBash("git diff 2>&1", REVIEW)).toBe(false);
		expect(commandMatchesAllowedBash("git diff &>out", REVIEW)).toBe(false);
		expect(commandMatchesAllowedBash("git diff <<<input", REVIEW)).toBe(false);
	});

	it("extracts process substitution the way it extracts $(…)", () => {
		expect(commandMatchesAllowedBash("git diff <(rm -rf /tmp/x)", REVIEW)).toBe(
			false,
		);
		expect(
			commandMatchesAllowedBash("git diff >(tee /root/.bashrc)", REVIEW),
		).toBe(false);
		// The inner command is found, not merely flagged.
		expect(scanShellCommand("git diff <(rm -rf /tmp/x)")?.segments).toEqual([
			"rm -rf /tmp/x",
			"git diff",
		]);
	});

	it("refuses an option flag that writes a file", () => {
		expect(
			commandMatchesAllowedBash("git diff --output=/root/.bashrc", REVIEW),
		).toBe(false);
		expect(
			commandMatchesAllowedBash("git diff --output /root/.bashrc", REVIEW),
		).toBe(false);
		expect(commandMatchesAllowedBash("git diff -o /root/.bashrc", REVIEW)).toBe(
			false,
		);
	});

	it("still allows the inspection commands the preset exists to grant", () => {
		expect(commandMatchesAllowedBash("git diff HEAD", REVIEW)).toBe(true);
		expect(commandMatchesAllowedBash("git log --oneline -20", REVIEW)).toBe(
			true,
		);
		expect(commandMatchesAllowedBash("git diff HEAD | grep foo", REVIEW)).toBe(
			false, // `grep` is not granted as a shell command
		);
		expect(
			commandMatchesAllowedBash("git status && git diff --stat", REVIEW),
		).toBe(true);
	});

	it("keeps refusing the chained-mutation case the split exists for", () => {
		expect(
			commandMatchesAllowedBash("git diff HEAD && sed -i s/a/b/ f", REVIEW),
		).toBe(false);
		expect(commandMatchesAllowedBash("git diff $(rm -rf /tmp/x)", REVIEW)).toBe(
			false,
		);
	});

	it("leaves an unrestricted Bash grant unrestricted", () => {
		// A builder may redirect; the scan only gates narrowed grants.
		expect(commandMatchesAllowedBash("echo hi > f", ["Bash"])).toBe(true);
		expect(commandMatchesAllowedBash("echo hi > f", ["Bash(*)"])).toBe(true);
	});
});

describe("scanShellCommand", () => {
	it("reports redirection separately from the segments", () => {
		const scan = scanShellCommand("git diff HEAD > out.txt");
		expect(scan).toEqual({
			segments: ["git diff HEAD > out.txt"],
			hasRedirection: true,
		});
	});

	it("does not treat a quoted operator as a redirection", () => {
		expect(scanShellCommand("git log --grep '>'")).toEqual({
			segments: ["git log --grep '>'"],
			hasRedirection: false,
		});
		expect(scanShellCommand("git log --grep \\>")).toEqual({
			segments: ["git log --grep \\>"],
			hasRedirection: false,
		});
	});

	it("closes a substitution at the right paren, not at a quoted one", () => {
		expect(scanShellCommand('echo $(echo ")")')?.segments).toEqual([
			'echo ")"',
			"echo",
		]);
	});

	it("does not end a backtick substitution on an escaped backtick", () => {
		expect(scanShellCommand("echo `echo \\` hi`")?.segments).toEqual([
			"echo \\` hi",
			"echo",
		]);
	});

	it("fails closed on an unterminated quote or substitution", () => {
		expect(scanShellCommand("git diff 'unterminated")).toBeNull();
		expect(scanShellCommand("git diff $(unterminated")).toBeNull();
		expect(splitShellCommands("git diff 'unterminated")).toBeNull();
	});
});

describe("grant shape helpers", () => {
	it("recognises the unrestricted shapes", () => {
		expect(grantsUnrestrictedBash(["Bash"])).toBe(true);
		expect(grantsUnrestrictedBash(["Bash(*)"])).toBe(true);
		expect(grantsUnrestrictedBash(["Bash(**)"])).toBe(true);
		expect(grantsUnrestrictedBash(["Bash(git diff:*)"])).toBe(false);
	});

	it("finds any Bash grant at all", () => {
		expect(hasBashGrant(["Read", "Bash(git diff:*)"])).toBe(true);
		expect(hasBashGrant(["Read", "Glob"])).toBe(false);
	});

	it("compiles a mid-pattern wildcard as one argument", () => {
		const matcher = compileBashPattern("git -C * pull");
		expect(matcher).not.toBe("match-all");
		expect((matcher as RegExp).test("git -C /repo pull")).toBe(true);
		expect((matcher as RegExp).test("git -C /repo push")).toBe(false);
	});
});
