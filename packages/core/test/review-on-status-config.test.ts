import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RepositoryConfigSchema } from "../src/config-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseRepo = {
	id: "repo-1",
	name: "My Repo",
	repositoryPath: "/repos/my-repo",
	baseBranch: "main",
	workspaceBaseDir: "/workspaces",
};

describe("RepositoryConfigSchema.reviewOnStatus", () => {
	it("accepts a workflow state name", () => {
		const parsed = RepositoryConfigSchema.parse({
			...baseRepo,
			reviewOnStatus: "In Review",
		});

		expect(parsed.reviewOnStatus).toBe("In Review");
	});

	it("is optional — existing configs stay valid", () => {
		const parsed = RepositoryConfigSchema.parse(baseRepo);

		expect(parsed.reviewOnStatus).toBeUndefined();
	});

	it("rejects a non-string value", () => {
		expect(() =>
			RepositoryConfigSchema.parse({ ...baseRepo, reviewOnStatus: true }),
		).toThrow();
	});

	it("is exported to the generated JSON schema", () => {
		const schema = JSON.parse(
			readFileSync(
				resolve(__dirname, "../schemas/RepositoryConfig.json"),
				"utf-8",
			),
		);

		expect(schema.properties).toHaveProperty("reviewOnStatus");
		expect(schema.properties.reviewOnStatus.type).toBe("string");
		expect(schema.required).not.toContain("reviewOnStatus");
	});
});
