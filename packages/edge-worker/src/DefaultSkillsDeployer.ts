import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "cyrus-core";

/**
 * Deploys bundled default skills to the cyrusHome directory.
 *
 * On first startup, copies all bundled skill directories from the package
 * into `~/.cyrus/cyrus-skills-plugin/skills/` so that users can inspect
 * and customize them. Subsequent startups backfill any bundled skill that
 * has never been deployed before (e.g. a new skill added in a later Cyrus
 * release) while leaving already-known skills alone — including ones the
 * user has deliberately deleted.
 *
 * Single Responsibility: this class only handles deployment of default
 * skills from the package to the user's home directory.
 */
export class DefaultSkillsDeployer {
	private readonly bundledSkillsPath: string;
	private readonly deployedPluginPath: string;
	private readonly deployedSkillsPath: string;
	private readonly manifestDir: string;
	private readonly manifestPath: string;
	private readonly deployedSkillsRecordPath: string;

	constructor(
		private readonly cyrusHome: string,
		private readonly logger: ILogger,
		bundledSkillsDir?: string,
	) {
		// Default: skills live alongside the compiled JS in dist/, placed there
		// by the copy-prompts build step. Callers (e.g. tests) can override.
		this.bundledSkillsPath =
			bundledSkillsDir ??
			join(
				dirname(fileURLToPath(import.meta.url)),
				"cyrus-skills-plugin",
				"skills",
			);
		this.deployedPluginPath = join(this.cyrusHome, "cyrus-skills-plugin");
		this.deployedSkillsPath = join(this.deployedPluginPath, "skills");
		this.manifestDir = join(this.deployedPluginPath, ".claude-plugin");
		this.manifestPath = join(this.manifestDir, "plugin.json");
		// Tracks every skill name this deployer has ever copied in, so later
		// runs can tell "never deployed, needs backfilling" apart from
		// "deployed before, user deleted it on purpose".
		this.deployedSkillsRecordPath = join(
			this.deployedPluginPath,
			".deployed-skills.json",
		);
	}

	/**
	 * Ensure default skills are deployed to cyrusHome.
	 *
	 * On first run, creates `~/.cyrus/cyrus-skills-plugin/` and copies every
	 * bundled skill into it. On later runs, copies in only the bundled
	 * skills that have never been deployed before — a skill this deployer
	 * previously copied and the user since removed is left deleted.
	 */
	async ensureDeployed(): Promise<void> {
		if (!(await this.exists(this.bundledSkillsPath))) {
			this.logger.warn(
				`Bundled skills not found at ${this.bundledSkillsPath} — cannot deploy defaults`,
			);
			return;
		}

		const pluginExists = await this.exists(this.deployedPluginPath);

		await mkdir(this.deployedSkillsPath, { recursive: true });
		await mkdir(this.manifestDir, { recursive: true });
		if (!(await this.exists(this.manifestPath))) {
			await writeFile(
				this.manifestPath,
				JSON.stringify(
					{
						name: "cyrus-skills",
						description: "Default Cyrus workflow skills for agent sessions",
					},
					null,
					"\t",
				),
			);
		}

		// Skills this deployer has previously copied in. Missing on a fresh
		// install (empty set — everything is new); backfilled from the
		// currently-deployed directory names on an existing install that
		// predates this record (so nothing already-deleted reappears).
		const previouslyDeployed = pluginExists
			? await this.loadDeployedSkillsRecord()
			: new Set<string>();

		const bundledNames = await this.readSkillDirNames(this.bundledSkillsPath);
		let deployedCount = 0;
		for (const name of bundledNames) {
			if (previouslyDeployed.has(name)) {
				continue;
			}
			const src = join(this.bundledSkillsPath, name);
			const dest = join(this.deployedSkillsPath, name);
			await cp(src, dest, { recursive: true, dereference: true });
			previouslyDeployed.add(name);
			deployedCount++;
		}

		await this.saveDeployedSkillsRecord(previouslyDeployed);

		if (deployedCount > 0) {
			this.logger.info(
				pluginExists
					? `Backfilled ${deployedCount} new default skill(s) into ${this.deployedPluginPath}`
					: `Deployed default skills to ${this.deployedPluginPath} (${deployedCount} skills)`,
			);
		} else {
			this.logger.debug(
				`Default skills plugin already up to date at ${this.deployedPluginPath}`,
			);
		}
	}

	/**
	 * Read the record of skill names this deployer has ever copied in.
	 *
	 * Absent or unparseable record means an install that predates this
	 * tracking mechanism — treat every currently-deployed skill directory as
	 * already-known so a prior user deletion isn't mistaken for "never
	 * deployed" and silently reinstated.
	 */
	private async loadDeployedSkillsRecord(): Promise<Set<string>> {
		try {
			const raw = await readFile(this.deployedSkillsRecordPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return new Set(
					parsed.filter((v): v is string => typeof v === "string"),
				);
			}
		} catch {
			// Missing or unparseable — fall through to the legacy-install backfill below.
		}
		return new Set(await this.readSkillDirNames(this.deployedSkillsPath));
	}

	private async saveDeployedSkillsRecord(names: Set<string>): Promise<void> {
		await writeFile(
			this.deployedSkillsRecordPath,
			JSON.stringify([...names].sort(), null, "\t"),
		);
	}

	/**
	 * Read the immediate subdirectory (and symlink) names of a skills
	 * directory. Entries may be directories or symlinks to directories (dev
	 * vs build). Returns an empty array when the directory is missing.
	 */
	private async readSkillDirNames(skillsDir: string): Promise<string[]> {
		try {
			const entries = await readdir(skillsDir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
