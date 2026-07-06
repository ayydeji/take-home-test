import express, { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { Db } from "./db/client";

export function buildApp(db: Db) {
	const app = express();

	app.use(express.json());

	app.get("/health", async (_req: Request, res: Response) => {
		try {
			await db.orm.execute(sql`select 1`);
			res.status(200).json({ status: "ok" });
		} catch {
			res.status(503).json({ status: "unavailable" });
		}
	});

	app.post("/ingest", (req: Request, res: Response) => {
		res.json({ message: "Ingesting form data" });
	});

	return app;
}
