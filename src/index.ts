import { buildApp } from "./app";
import { createDb } from "./db/client";
import { config } from "./config";
import { createDefaultRunner } from "./pipeline/run";
import { createSweeper } from "./pipeline/sweeper";

const db = createDb();
const runner = createDefaultRunner(db);
const app = buildApp(db, { runner });
const sweeper = createSweeper(db, { runner });
sweeper.start();

const server = app.listen(config.port, () => {
	console.log(`Server is running on http://localhost:${config.port}`);
});

function shutdown() {
	sweeper.stop();
	server.close(() => {
		db.pool.end().then(() => process.exit(0));
	});
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
