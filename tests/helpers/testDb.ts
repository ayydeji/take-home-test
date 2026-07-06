import path from "node:path";
import {
	PostgreSqlContainer,
	StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, Db } from "../../src/db/client";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

export function runMigrations(orm: Db["orm"]): Promise<void> {
	return migrate(orm, { migrationsFolder });
}

export interface TestDb {
	db: Db;
	container: StartedPostgreSqlContainer;
	stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
	const container = await new PostgreSqlContainer("postgres:16-alpine").start();
	const db = createDb(container.getConnectionUri());
	await runMigrations(db.orm);

	return {
		db,
		container,
		stop: async () => {
			await db.pool.end();
			await container.stop();
		},
	};
}
