import express, { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { Db } from "./db/client";
import { ingestForm } from "./ingest/ingestForm";

function readNumericStatus(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) {
		return undefined;
	}
	const record = err as Record<string, unknown>;
	const status = record.status ?? record.statusCode;
	return typeof status === "number" ? status : undefined;
}

export function buildApp(db: Db) {
	const app = express();

	app.use(express.json({ limit: "1mb" }));

	app.get("/health", async (_req: Request, res: Response) => {
		try {
			await db.orm.execute(sql`select 1`);
			res.status(200).json({ status: "ok" });
		} catch {
			res.status(503).json({ status: "unavailable" });
		}
	});

	app.post(
		"/ingest",
		async (req: Request, res: Response, next: NextFunction) => {
			try {
				const result = await ingestForm(db, req.body);
				if (result.outcome === "duplicate") {
					return res.status(200).json({ id: result.id, duplicate: true });
				}
				if (result.outcome === "conflict") {
					return res.status(202).json({ id: result.id, conflict: true });
				}
				return res.status(202).json({ id: result.id });
			} catch (err) {
				next(err);
			}
		},
	);

	app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (res.headersSent) {
			return next(err);
		}
		const status = readNumericStatus(err) ?? 500;
		res.status(status).json({
			error: status === 413 ? "payload too large" : "invalid request",
		});
	});

	return app;
}
