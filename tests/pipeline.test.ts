import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { buildApp } from "../src/app";
import { runPipeline, PipelineRunner } from "../src/pipeline/run";
import { createSweeper } from "../src/pipeline/sweeper";
import { Geocoder } from "../src/geocoder/client";
import validForm from "./fixtures/valid-form.json";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

const fakeGeocoder: Geocoder = {
	geocode: async () => ({
		ok: true,
		coordinates: { latitude: 51.5, longitude: -0.1 },
	}),
};

function insertForm(
	contentHash: string,
	options: { status?: string; updatedAt?: string; payload?: unknown } = {},
) {
	return ctx.db.pool
		.query(
			`insert into forms (content_hash, raw_payload, status, updated_at)
			 values ($1, $2, $3, coalesce($4::timestamptz, now()))
			 returning id`,
			[
				contentHash,
				JSON.stringify(options.payload ?? validForm),
				options.status ?? "RECEIVED",
				options.updatedAt ?? null,
			],
		)
		.then((result) => result.rows[0].id as string);
}

function loadForm(id: string) {
	return ctx.db.pool
		.query("select status from forms where id = $1", [id])
		.then((result) => result.rows[0]);
}

function loadEventsInOrder(id: string) {
	return ctx.db.pool
		.query(
			"select from_status, to_status from form_events where form_id = $1 order by created_at asc",
			[id],
		)
		.then((result) => result.rows);
}

function countByFormId(table: string, id: string) {
	return ctx.db.pool
		.query(`select count(*)::int as n from ${table} where form_id = $1`, [id])
		.then((result) => result.rows[0].n as number);
}

describe("pipeline end-to-end", () => {
	it("drives a new form from ingest through READY with all four events in order", async () => {
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		const response = await request(app).post("/ingest").send(validForm);
		expect(response.status).toBe(202);
		const id = response.body.id as string;

		await Promise.all(promises);

		const row = await loadForm(id);
		expect(row.status).toBe("READY");

		const events = await loadEventsInOrder(id);
		expect(events).toEqual([
			{ from_status: null, to_status: "RECEIVED" },
			{ from_status: "RECEIVED", to_status: "VALIDATED" },
			{ from_status: "VALIDATED", to_status: "GEOCODED" },
			{ from_status: "GEOCODED", to_status: "READY" },
		]);
	});
});

describe("sweeper", () => {
	it("recovers a form stuck in RECEIVED with a stale updated_at, but leaves a fresh one alone", async () => {
		const staleId = await insertForm("sweeper-stale-hash", {
			status: "RECEIVED",
			updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
		});
		const freshId = await insertForm("sweeper-fresh-hash", {
			status: "RECEIVED",
		});

		const runner: PipelineRunner = (formId) =>
			runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
		const sweeper = createSweeper(ctx.db, { runner, stalenessMs: 1000 });

		await sweeper.sweepOnce();

		expect((await loadForm(staleId)).status).toBe("READY");
		expect((await loadForm(freshId)).status).toBe("RECEIVED");
	});

	it("start/stop is graceful and idempotent", () => {
		const sweeper = createSweeper(ctx.db, {
			runner: async () => {},
			intervalMs: 50,
		});

		expect(() => {
			sweeper.start();
			sweeper.stop();
			sweeper.stop();
		}).not.toThrow();
	});
});

describe("concurrent runners", () => {
	it("two concurrent runPipeline calls on one form: each transition happens exactly once", async () => {
		const id = await insertForm("concurrent-runner-hash");

		await Promise.all([
			runPipeline(ctx.db, id, { geocoder: fakeGeocoder }),
			runPipeline(ctx.db, id, { geocoder: fakeGeocoder }),
		]);

		const row = await loadForm(id);
		expect(row.status).toBe("READY");

		const events = await loadEventsInOrder(id);
		expect(events).toEqual([
			{ from_status: "RECEIVED", to_status: "VALIDATED" },
			{ from_status: "VALIDATED", to_status: "GEOCODED" },
			{ from_status: "GEOCODED", to_status: "READY" },
		]);

		expect(await countByFormId("transformed_forms", id)).toBe(1);
		expect(await countByFormId("outbox", id)).toBe(1);
	});
});
