import express, {
	NextFunction,
	Request,
	RequestHandler,
	Response,
} from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { Db } from "./db/client";
import { ingestForm } from "./ingest/ingestForm";
import { getFormView } from "./forms/getFormView";
import { claimReadyForms, parseClaimLimit } from "./forms/claimReadyForms";
import { retryForm } from "./forms/retryForm";
import { PipelineRunner } from "./pipeline/run";
import { ApiKeyRing, Scope, requireScope } from "./auth";
import { Logger, requestLogger } from "./log";
import { config } from "./config";

const formIdSchema = z.string().uuid();

function readNumericStatus(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) {
		return undefined;
	}
	const record = err as Record<string, unknown>;
	const status = record.status ?? record.statusCode;
	return typeof status === "number" ? status : undefined;
}

export function buildApp(
	db: Db,
	deps: { runner?: PipelineRunner; apiKeys?: ApiKeyRing; logger?: Logger } = {},
) {
	const app = express();
	const runner = deps.runner;

	if (deps.logger) {
		app.use(requestLogger(deps.logger));
	}

	const limiter = deps.apiKeys
		? rateLimit({
				windowMs: 60_000,
				limit: config.rateLimit.perMinute,
				standardHeaders: true,
				legacyHeaders: false,
				keyGenerator: (req) =>
					req.header("x-api-key") ?? ipKeyGenerator(req.ip ?? "unknown"),
			})
		: undefined;

	function protect(scope: Scope): RequestHandler[] {
		if (!deps.apiKeys) {
			return [];
		}
		return [limiter as RequestHandler, requireScope(deps.apiKeys, scope)];
	}

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
		...protect("provider"),
		async (req: Request, res: Response, next: NextFunction) => {
			try {
				const result = await ingestForm(db, req.body);
				if (result.outcome === "duplicate") {
					return res.status(200).json({ id: result.id, duplicate: true });
				}
				if (result.outcome === "conflict") {
					return res.status(202).json({ id: result.id, conflict: true });
				}
				if (runner) {
					void runner(result.id).catch(() => {});
				}
				return res.status(202).json({ id: result.id });
			} catch (err) {
				next(err);
			}
		},
	);

	app.post(
		"/forms/ready",
		...protect("bot"),
		async (req: Request, res: Response, next: NextFunction) => {
			try {
				const limit = parseClaimLimit(req.query.limit);
				const claimed = await claimReadyForms(db, limit);
				return res.status(200).json(claimed);
			} catch (err) {
				next(err);
			}
		},
	);

	app.post(
		"/forms/:id/retry",
		...protect("ops"),
		async (req: Request, res: Response, next: NextFunction) => {
			try {
				const parsed = formIdSchema.safeParse(req.params.id);
				if (!parsed.success) {
					return res.status(400).json({ error: "invalid form id" });
				}
				const outcome = await retryForm(db, parsed.data);
				if (outcome.outcome === "not_found") {
					return res.status(404).json({ error: "form not found" });
				}
				if (outcome.outcome === "not_failed") {
					return res.status(409).json({ status: outcome.status });
				}
				if (outcome.outcome === "retried" && runner) {
					void runner(parsed.data).catch(() => {});
				}
				return res.status(202).json({ id: parsed.data });
			} catch (err) {
				next(err);
			}
		},
	);

	app.get(
		"/forms/:id",
		...protect("ops"),
		async (req: Request, res: Response, next: NextFunction) => {
			try {
				const parsed = formIdSchema.safeParse(req.params.id);
				if (!parsed.success) {
					return res.status(400).json({ error: "invalid form id" });
				}
				const view = await getFormView(db, parsed.data);
				if (view === null) {
					return res.status(404).json({ error: "form not found" });
				}
				return res.status(200).json(view);
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
