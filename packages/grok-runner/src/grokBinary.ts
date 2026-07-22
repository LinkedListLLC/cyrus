import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Grok Build CLI binary path.
 * Order: explicit path → GROK_PATH → PATH `grok` → ~/.grok/bin/grok
 */
export function resolveGrokBinary(explicitPath?: string): string {
	if (explicitPath && explicitPath.trim().length > 0) {
		return explicitPath;
	}
	if (process.env.GROK_PATH && process.env.GROK_PATH.trim().length > 0) {
		return process.env.GROK_PATH;
	}
	const managed = join(homedir(), ".grok", "bin", "grok");
	if (existsSync(managed)) {
		return managed;
	}
	return "grok";
}

/**
 * True when a Grok CLI login session file exists.
 * Does not read token contents (secrets stay out of process memory here).
 */
export function hasGrokCachedAuth(grokHome?: string): boolean {
	const home = grokHome || process.env.GROK_HOME || join(homedir(), ".grok");
	return existsSync(join(home, "auth.json"));
}
