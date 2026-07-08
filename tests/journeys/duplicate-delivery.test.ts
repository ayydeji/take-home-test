import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startTestDb, TestDb } from "../helpers/testDb";
import { buildApp } from "../../src/app";
import { runPipeline, PipelineRunner } from "../../src/pipeline/run";
import { createOutboxWorker } from "../../src/outbox/worker";
import { FakeMail } from "../../src/mail/provider";
import { Geocoder } from "../../src/geocoder/client";
import validForm from "../fixtures/valid-form.json";

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

// Story: the third-party provider is unreliable and occasionally re-delivers
// the same webhook. A form arrives, then arrives twice more — the second and
// third deliveries racing each other, exactly as a flaky retrying client
// would. No matter how many times the provider repeats itself, the system
// must end up with exactly one form, one outbox email, and one FORM-BOT
// handoff.
describe("journey: duplicate delivery", () => {
	it("collapses three deliveries, one of them concurrent, into one row, one email, one dispatch", async () => {
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		// First delivery: the provider's webhook fires.
		const first = await request(app).post("/ingest").send(validForm);
		expect(first.status).toBe(202);
		const id = first.body.id as string;

		// The provider's flaky client retries twice more, racing each other.
		const [second, third] = await Promise.all([
			request(app).post("/ingest").send(validForm),
			request(app).post("/ingest").send(validForm),
		]);
		expect(second.body).toEqual({ id, duplicate: true });
		expect(third.body).toEqual({ id, duplicate: true });

		// Only the first delivery ever entered the pipeline; let it finish.
		await Promise.all(promises);

		const forms = await ctx.db.pool.query(
			"select count(*)::int as n from forms where id = $1",
			[id],
		);
		expect(forms.rows[0].n).toBe(1);

		const status = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[id],
		);
		expect(status.rows[0].status).toBe("READY");

		// The outbox worker fires: exactly one email goes out for this form,
		// no matter how many times ingest was called.
		const mail = new FakeMail();
		const outbox = createOutboxWorker(ctx.db, { mail });
		await outbox.tick();
		expect(mail.sent).toHaveLength(1);

		// FORM-BOT claims: exactly one delivery.
		const claimed = await request(app).post("/forms/ready");
		expect(claimed.body).toHaveLength(1);
		expect(claimed.body[0].id).toBe(id);

		const final = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[id],
		);
		expect(final.rows[0].status).toBe("DISPATCHED");
	});
});
