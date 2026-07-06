import type { Config } from "drizzle-kit";
import { config } from "./src/config";

export default {
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: config.databaseUrl,
	},
} satisfies Config;
