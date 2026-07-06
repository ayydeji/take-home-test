import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config";
import * as schema from "./schema";

export interface Db {
	pool: Pool;
	orm: NodePgDatabase<typeof schema>;
}

export function createDb(connectionString: string = config.databaseUrl): Db {
	const pool = new Pool({ connectionString });
	const orm = drizzle(pool, { schema });
	return { pool, orm };
}
