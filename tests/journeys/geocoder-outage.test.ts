import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startTestDb, TestDb } from "../helpers/testDb";
import { buildApp } from "../../src/app";
import { runPipeline, PipelineRunner } from "../../src/pipeline/run";
import { Geocoder } from "../../src/geocoder/client";
import validForm from "../fixtures/valid-form.json";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

function createOutageGeocoder(): Geocoder & {
	calls: number;
	heal: () => void;
} {
	let down = true;
	return {
		calls: 0,
		heal() {
			down = false;
		},
		async geocode() {
			this.calls++;
			if (down) {
				return { ok: false, reason: "upstream_error" };
			}
			return { ok: true, coordinates: { latitude: 51.5, longitude: -0.1 } };
		},
	};
}

// Story: the geocoding provider is down when a form is submitted. The form
// parks in FAILED_GEOCODING rather than being lost — nothing loops forever
// hammering a dead dependency. Once the outage is resolved, an operator
// retries the form and it completes normally, coordinates now cached on the
// row. When the provider later re-delivers the exact same webhook (a
// replay), the system recognizes the duplicate at the door and does no
// redundant geocoding work at all.
describe("journey: geocoder outage and recovery", () => {
	it("parks in FAILED_GEOCODING during the outage, recovers via retry, and never re-geocodes a replay", async () => {
		const geocoder = createOutageGeocoder();
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		const ingestResponse = await request(app).post("/ingest").send(validForm);
		expect(ingestResponse.status).toBe(202);
		const id = ingestResponse.body.id as string;

		await Promise.all(promises);

		const parked = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[id],
		);
		expect(parked.rows[0].status).toBe("FAILED_GEOCODING");
		expect(geocoder.calls).toBe(1);

		// The outage is resolved.
		geocoder.heal();

		promises.length = 0;
		const retryResponse = await request(app).post(`/forms/${id}/retry`);
		expect(retryResponse.status).toBe(202);

		await Promise.all(promises);

		const recovered = await ctx.db.pool.query(
			"select status, latitude, longitude from forms where id = $1",
			[id],
		);
		expect(recovered.rows[0].status).toBe("READY");
		expect(recovered.rows[0].latitude).not.toBeNull();
		expect(geocoder.calls).toBe(2);

		// The provider's webhook fires again for the exact same form — a
		// replay. Ingest recognizes the duplicate before the pipeline ever
		// runs, so the now-healthy geocoder is never called a third time.
		const replay = await request(app).post("/ingest").send(validForm);
		expect(replay.body).toEqual({ id, duplicate: true });
		expect(geocoder.calls).toBe(2);

		const finalCount = await ctx.db.pool.query(
			`select count(*)::int as n from forms
			 where content_hash = (select content_hash from forms where id = $1)`,
			[id],
		);
		expect(finalCount.rows[0].n).toBe(1);
	});
});
