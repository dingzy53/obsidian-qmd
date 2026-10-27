import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**", "test/obsidian-stub.ts"],
	},
	...tseslint.configs.recommended,
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
);
