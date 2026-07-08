import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import request from "supertest";
import { startTestDb, TestDb } from "../helpers/testDb";
import { buildApp } from "../../src/app";
import { runPipeline, PipelineRunner } from "../../src/pipeline/run";
import { Geocoder } from "../../src/geocoder/client";
import {
	CURRENT_INGESTED_VERSION,
	registerIngestedSchema,
	setCurrentIngestedVersion,
} from "../../src/schemas/ingested/registry";
import validForm from "../fixtures/valid-form.json";

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

// Story: the provider silently renames date_of_birth to dob. Every form they
// send from that moment fails validation against the schema the service
// currently knows about — but it isn't dropped, it's quarantined, raw
// payload intact. An engineer notices, ships a v2 schema that knows how to
// translate the rename, and retries the quarantined form. It resumes right
// where it left off (no re-validation with the wrong schema, no re-running
// steps that never failed) and flows all the way through to a FORM-BOT
// handoff. Nothing about the original, oddly-shaped payload is ever lost.
describe("journey: schema drift and retry", () => {
	it("quarantines a renamed field, then flows to READY and claim once v2 is registered", async () => {
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		// The provider renames date_of_birth -> dob without warning.
		const driftedPayload: Record<string, unknown> = { ...validForm };
		delete driftedPayload.date_of_birth;
		driftedPayload.dob = validForm.date_of_birth;

		const ingestResponse = await request(app)
			.post("/ingest")
			.send(driftedPayload);
		expect(ingestResponse.status).toBe(202);
		const id = ingestResponse.body.id as string;

		await Promise.all(promises);

		const quarantined = await ctx.db.pool.query(
			"select status, raw_payload from forms where id = $1",
			[id],
		);
		expect(quarantined.rows[0].status).toBe("FAILED_VALIDATION");
		// Zero data lost: the renamed-field payload is preserved verbatim.
		expect(quarantined.rows[0].raw_payload).toEqual(driftedPayload);

		// An engineer ships a v2 schema that understands the rename.
		registerIngestedSchema(
			"v2",
			z
				.object({
					session_id: z.string(),
					application_reference: z.string(),
					name: z.string(),
					email: z.string(),
					gender: z.enum(["male", "female", "other"]),
					dob: z.string(),
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
				.passthrough()
				.transform((data) => ({ ...data, date_of_birth: data.dob })),
		);
		setCurrentIngestedVersion("v2");

		promises.length = 0;
		const retryResponse = await request(app).post(`/forms/${id}/retry`);
		expect(retryResponse.status).toBe(202);

		await Promise.all(promises);

		const recovered = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[id],
		);
		expect(recovered.rows[0].status).toBe("READY");

		// FORM-BOT can now claim it.
		const claimed = await request(app).post("/forms/ready");
		const claimedIds = claimed.body.map((f: { id: string }) => f.id);
		expect(claimedIds).toContain(id);

		const final = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[id],
		);
		expect(final.rows[0].status).toBe("DISPATCHED");
	});
});
