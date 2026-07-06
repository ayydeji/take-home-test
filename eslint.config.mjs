import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
	{ ignores: ["dist", "drizzle", "node_modules"] },
	...tseslint.configs.recommended,
	{
		files: ["src/providers/**/*.ts"],
		rules: {
			// Mock providers intentionally ignore their inputs to simulate
			// non-deterministic third-party responses.
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
		},
	},
	eslintConfigPrettier,
);
