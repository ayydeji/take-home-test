import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { geocodeForm } from "../src/pipeline/steps/geocode";
import { createGeocoder, Geocoder } from "../src/geocoder/client";
import validForm from "./fixtures/valid-form.json";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

function insertValidatedForm(
	contentHash: string,
	overrides: { latitude?: number; longitude?: number } = {},
) {
	return ctx.db.pool
		.query(
			`insert into forms (content_hash, raw_payload, status, latitude, longitude)
			 values ($1, $2, 'VALIDATED', $3, $4)
			 returning id`,
			[
				contentHash,
				JSON.stringify(validForm),
				overrides.latitude ?? null,
				overrides.longitude ?? null,
			],
		)
		.then((result) => result.rows[0].id as string);
}

function loadForm(id: string) {
	return ctx.db.pool
		.query(
			"select status, latitude, longitude, last_error from forms where id = $1",
			[id],
		)
		.then((result) => result.rows[0]);
}

function loadEvents(id: string) {
	return ctx.db.pool
		.query(
			"select from_status, to_status from form_events where form_id = $1",
			[id],
		)
		.then((result) => result.rows);
}

const fixedGeocoder = (coordinates: {
	latitude: number;
	longitude: number;
}): Geocoder => ({
	geocode: async () => ({ ok: true, coordinates }),
});

describe("geocodeForm", () => {
	it("persists coordinates and transitions to GEOCODED on success", async () => {
		const id = await insertValidatedForm("geocode-success-hash");
		const geocoder = fixedGeocoder({ latitude: 51.5, longitude: -0.1 });

		const outcome = await geocodeForm(ctx.db, id, geocoder);
		expect(outcome).toEqual({ outcome: "geocoded", cached: false });

		const row = await loadForm(id);
		expect(row.status).toBe("GEOCODED");
		expect(Number(row.latitude)).toBe(51.5);
		expect(Number(row.longitude)).toBe(-0.1);

		const events = await loadEvents(id);
		expect(events).toEqual([
			{ from_status: "VALIDATED", to_status: "GEOCODED" },
		]);
	});

	it("calls exactly the retry budget and ends FAILED_GEOCODING when it always fails", async () => {
		const id = await insertValidatedForm("geocode-fail-hash");
		let calls = 0;
		const geocoder = createGeocoder(
			async () => {
				calls++;
				return { statusCode: 500, body: undefined };
			},
			{ timeoutMs: 50, attempts: 3, backoffMs: 1 },
		);

		const outcome = await geocodeForm(ctx.db, id, geocoder);
		expect(outcome).toEqual({ outcome: "failed", reason: "upstream_error" });
		expect(calls).toBe(3);

		const row = await loadForm(id);
		expect(row.status).toBe("FAILED_GEOCODING");
		expect(row.last_error).toEqual({ reason: "upstream_error" });

		const events = await loadEvents(id);
		expect(events).toEqual([
			{ from_status: "VALIDATED", to_status: "FAILED_GEOCODING" },
		]);
	});

	it("takes the timeout path without hanging when the lookup never resolves", async () => {
		const id = await insertValidatedForm("geocode-timeout-hash");
		const geocoder = createGeocoder(() => new Promise(() => {}), {
			timeoutMs: 10,
			attempts: 1,
			backoffMs: 1,
		});

		const outcome = await geocodeForm(ctx.db, id, geocoder);
		expect(outcome).toEqual({ outcome: "failed", reason: "timeout" });

		const row = await loadForm(id);
		expect(row.status).toBe("FAILED_GEOCODING");
	});

	it("skips the API entirely when coordinates are already cached", async () => {
		const id = await insertValidatedForm("geocode-cached-hash", {
			latitude: 12.34,
			longitude: 56.78,
		});
		let calls = 0;
		const geocoder: Geocoder = {
			geocode: async () => {
				calls++;
				return { ok: true, coordinates: { latitude: 0, longitude: 0 } };
			},
		};

		const outcome = await geocodeForm(ctx.db, id, geocoder);
		expect(outcome).toEqual({ outcome: "geocoded", cached: true });
		expect(calls).toBe(0);

		const row = await loadForm(id);
		expect(row.status).toBe("GEOCODED");
		expect(Number(row.latitude)).toBe(12.34);
		expect(Number(row.longitude)).toBe(56.78);
	});

	it("running it twice produces exactly one transition and one event", async () => {
		const id = await insertValidatedForm("geocode-repeat-hash");
		const geocoder = fixedGeocoder({ latitude: 1, longitude: 2 });

		const first = await geocodeForm(ctx.db, id, geocoder);
		const second = await geocodeForm(ctx.db, id, geocoder);

		expect(first).toEqual({ outcome: "geocoded", cached: false });
		expect(second).toEqual({ outcome: "skipped" });

		const row = await loadForm(id);
		expect(row.status).toBe("GEOCODED");

		const events = await loadEvents(id);
		expect(events).toHaveLength(1);
	});
});
