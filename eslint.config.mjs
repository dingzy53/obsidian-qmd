import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The same rules the community-plugin review runs, plus two stricter local ones.
export default defineConfig([
	{
		ignores: ["main.js", "node_modules/**", "test/obsidian-stub.ts"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["*.mjs", "scripts/*.mjs", "vitest.config.ts"],
				},
			},
		},
	},
	{
		files: ["**/*.ts"],
		rules: {
			// The codebase should not need `any`; AGENTS.md requires a comment
			// justifying any that appears.
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
]);
