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

const fakeGeocoder: Geocoder = {
	geocode: async () => ({
		ok: true,
		coordinates: { latitude: 51.5, longitude: -0.1 },
	}),
};

function countByStatus(ids: string[], status: string) {
	const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
	return ctx.db.pool
		.query(
			`select count(*)::int as n from forms where status = $1 and id in (${placeholders})`,
			[status, ...ids],
		)
		.then((result) => result.rows[0].n as number);
}

// Story: fifteen forms have made it all the way through the pipeline to
// READY. Two FORM-BOT workers happen to poll for work at the same moment.
// Neither should see a form the other already claimed, together they must
// account for every one of the fifteen, and every form ends up dispatched
// exactly once — the claim lock, not application luck, is what makes this
// hold.
describe("journey: two bots racing to claim", () => {
	it("splits 15 real, pipeline-processed forms across two concurrent claims with no overlap and no leftovers", async () => {
		const promises: Promise<void>[] = [];
		const runner: PipelineRunner = (formId) => {
			const p = runPipeline(ctx.db, formId, { geocoder: fakeGeocoder });
			promises.push(p);
			return p;
		};
		const app = buildApp(ctx.db, { runner });

		const ids: string[] = [];
		for (let i = 0; i < 15; i++) {
			const payload = { ...validForm, session_id: `claim-race-session-${i}` };
			const response = await request(app).post("/ingest").send(payload);
			expect(response.status).toBe(202);
			ids.push(response.body.id as string);
		}

		await Promise.all(promises);
		expect(await countByStatus(ids, "READY")).toBe(15);

		// Two bots poll at the same moment.
		const [first, second] = await Promise.all([
			request(app).post("/forms/ready").query({ limit: 10 }),
			request(app).post("/forms/ready").query({ limit: 10 }),
		]);

		const firstIds: string[] = first.body.map((f: { id: string }) => f.id);
		const secondIds: string[] = second.body.map((f: { id: string }) => f.id);

		const intersection = firstIds.filter((id) => secondIds.includes(id));
		expect(intersection).toEqual([]);

		const union = new Set([...firstIds, ...secondIds]);
		expect(union).toEqual(new Set(ids));

		expect(await countByStatus(ids, "DISPATCHED")).toBe(15);
	});
});
