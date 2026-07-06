import { buildApp } from "./app";
import { createDb } from "./db/client";
import { config } from "./config";

const db = createDb();
const app = buildApp(db);

const server = app.listen(config.port, () => {
	console.log(`Server is running on http://localhost:${config.port}`);
});

function shutdown() {
	server.close(() => {
		db.pool.end().then(() => process.exit(0));
	});
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
