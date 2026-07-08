import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import request from "supertest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { buildApp } from "../src/app";
import { retryForm } from "../src/forms/retryForm";
import { runPipeline, PipelineRunner } from "../src/pipeline/run";
import { Geocoder } from "../src/geocoder/client";
import {
	CURRENT_INGESTED_VERSION,
	registerIngestedSchema,
	setCurrentIngestedVersion,
} from "../src/schemas/ingested/registry";
import validForm from "./fixtures/valid-form.json";
import wrongTypeForm from "./fixtures/wrong-type-form.json";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

afterEach(() => {
	setCurrentIngestedVersion(CURRENT_INGESTED_VERSION);
});

const fakeGeocoder: Geocoder = {
	geocode: async () => ({
		ok: true,
		coordinates: { latitude: 51.5, longitude: -0.1 },
	}),
};

function insertForm(
	contentHash: string,
	options: {
		status?: string;
		schemaVersion?: string | null;
		latitude?: number | null;
		longitude?: number | null;
		lastError?: unknown;
		payload?: unknown;
	} = {},
) {
	return ctx.db.pool
		.query(
			`insert into forms (content_hash, raw_payload, status, schema_version, latitude, longitude, last_error)
			 values ($1, $2, $3, $4, $5, $6, $7)
			 returning id`,
			[
				contentHash,
				JSON.stringify(options.payload ?? validForm),
				options.status ?? "RECEIVED",
				options.schemaVersion ?? null,
				options.latitude ?? null,
				options.longitude ?? null,
				options.lastError !== undefined
					? JSON.stringify(options.lastError)
					: null,
			],
		)
		.then((result) => result.rows[0].id as string);
}

function loadForm(id: string) {
	return ctx.db.pool
		.query("select status from forms where id = $1", [id])
		.then((result) => result.rows[0]);
}

function loadEvents(id: string) {
	return ctx.db.pool
		.query(
			"select from_status, to_status, detail from form_events where form_id = $1 order by created_at asc",
			[id],
		)
		.then((result) => result.rows);
}

function countByFormId(table: string, id: string) {
	return ctx.db.pool
		.query(`select count(*)::int as n from ${table} where form_id = $1`, [id])
		.then((result) => result.rows[0].n as number);
}

describe("POST /forms/:id/retry", () => {
	it("drift story end to end: v1 rejects, v2 accepts, retry reaches READY", async () => {
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		const ingestResponse = await request(app)
			.post("/ingest")
			.send(wrongTypeForm);
		expect(ingestResponse.status).toBe(202);
		const id = ingestResponse.body.id as string;

		await Promise.all(promises);
		expect((await loadForm(id)).status).toBe("FAILED_VALIDATION");

		registerIngestedSchema(
			"v2",
			z
				.object({
					session_id: z.string(),
					application_reference: z.string(),
					name: z.string(),
					email: z.string(),
					gender: z.string(),
					date_of_birth: z.string(),
					phone_number: z.string().optional(),
					mobile_number: z.string(),
					address: z.object({
						address_line_1: z.string(),
						address_line_2: z.string(),
						address_line_3: z.string().optional(),
						postcode: z.string(),
						country: z.string(),
					}),
				})
				.passthrough(),
		);
		setCurrentIngestedVersion("v2");

		promises.length = 0;
		const retryResponse = await request(app).post(`/forms/${id}/retry`);
		expect(retryResponse.status).toBe(202);

		await Promise.all(promises);

		expect((await loadForm(id)).status).toBe("READY");
		expect(await countByFormId("outbox", id)).toBe(1);
	});

	it("returns 409 for a DISPATCHED form and changes nothing", async () => {
		const id = await insertForm("retry-dispatched-hash", {
			status: "DISPATCHED",
		});
		let calls = 0;
		const runner: PipelineRunner = async () => {
			calls++;
		};
		const app = buildApp(ctx.db, { runner });

		const response = await request(app).post(`/forms/${id}/retry`);

		expect(response.status).toBe(409);
		expect(response.body).toEqual({ status: "DISPATCHED" });
		expect((await loadForm(id)).status).toBe("DISPATCHED");
		expect(await countByFormId("form_events", id)).toBe(0);
		expect(calls).toBe(0);
	});

	it("returns 404 for an unknown id", async () => {
		const app = buildApp(ctx.db);
		const response = await request(app).post(
			"/forms/00000000-0000-0000-0000-000000000000/retry",
		);
		expect(response.status).toBe(404);
	});

	it("two parallel retries: one CAS transition, one pipeline run", async () => {
		const id = await insertForm("retry-parallel-hash", {
			status: "FAILED_VALIDATION",
			lastError: { path: "gender", code: "invalid_enum_value" },
		});

		// Two same-process loopback HTTP calls don't reliably interleave at the DB
		// level (the first tends to finish before the second's socket is even
		// accepted), so the CAS race is exercised directly against retryForm here,
		// matching every other CAS-guarded step in this suite. The app route only
		// invokes the runner when outcome === "retried" (covered by the other
		// single-call tests below), so exactly one "retried" here means exactly
		// one pipeline run would follow in production.
		const outcomes = await Promise.all([
			retryForm(ctx.db, id),
			retryForm(ctx.db, id),
		]);

		expect(outcomes.filter((o) => o.outcome === "retried")).toHaveLength(1);
		// The loser either lost the in-transaction CAS ("race_lost") or, if the
		// winner's whole transaction had already committed by the time the
		// loser's pre-check ran, observed the already-advanced status
		// ("not_failed") — both are valid "did not win" outcomes; either way
		// exactly one transition and one event occurred (asserted below).
		expect(
			outcomes.filter(
				(o) => o.outcome === "race_lost" || o.outcome === "not_failed",
			),
		).toHaveLength(1);
		expect((await loadForm(id)).status).toBe("RECEIVED");

		const events = await loadEvents(id);
		expect(events).toEqual([
			{
				from_status: "FAILED_VALIDATION",
				to_status: "RECEIVED",
				detail: { retry_from: "FAILED_VALIDATION" },
			},
		]);
	});

	it("retries FAILED_GEOCODING with cached coordinates: no geocoder calls, no re-validation", async () => {
		const id = await insertForm("retry-cached-geocode-hash", {
			status: "FAILED_GEOCODING",
			schemaVersion: "v1",
			latitude: 51.5,
			longitude: -0.1,
			lastError: { reason: "timeout" },
		});

		let geocoderCalls = 0;
		const spyGeocoder: Geocoder = {
			geocode: async () => {
				geocoderCalls++;
				return { ok: true, coordinates: { latitude: 0, longitude: 0 } };
			},
		};

		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: spyGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		const response = await request(app).post(`/forms/${id}/retry`);
		expect(response.status).toBe(202);

		await Promise.all(promises);

		expect(geocoderCalls).toBe(0);
		expect((await loadForm(id)).status).toBe("READY");
		expect(await countByFormId("outbox", id)).toBe(1);

		const events = await loadEvents(id);
		expect(events.map((e) => `${e.from_status}->${e.to_status}`)).toEqual([
			"FAILED_GEOCODING->VALIDATED",
			"VALIDATED->GEOCODED",
			"GEOCODED->READY",
		]);
	});
});
