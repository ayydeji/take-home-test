import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { transformAndPersist } from "../src/pipeline/steps/transform";
import validForm from "./fixtures/valid-form.json";

const PII_MARKER = validForm.date_of_birth;

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

function insertGeocodedForm(contentHash: string) {
	return ctx.db.pool
		.query(
			`insert into forms (content_hash, raw_payload, status, schema_version, latitude, longitude)
			 values ($1, $2, 'GEOCODED', 'v1', $3, $4)
			 returning id`,
			[contentHash, JSON.stringify(validForm), 51.5, -0.1],
		)
		.then((result) => result.rows[0].id as string);
}

function loadForm(id: string) {
	return ctx.db.pool
		.query("select status, last_error from forms where id = $1", [id])
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

function countByFormId(table: string, id: string) {
	return ctx.db.pool
		.query(`select count(*)::int as n from ${table} where form_id = $1`, [id])
		.then((result) => result.rows[0].n as number);
}

describe("transformAndPersist", () => {
	it("persists the transformed row, one outbox row, flips to READY, writes one event", async () => {
		const id = await insertGeocodedForm("transform-success-hash");

		const outcome = await transformAndPersist(ctx.db, id);
		expect(outcome).toEqual({ outcome: "transformed" });

		const transformed = await ctx.db.pool.query(
			"select payload from transformed_forms where form_id = $1",
			[id],
		);
		expect(transformed.rows).toHaveLength(1);
		expect(transformed.rows[0].payload.firstName).toBe("Jordan");

		const outbox = await ctx.db.pool.query(
			"select type, status, payload from outbox where form_id = $1",
			[id],
		);
		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0].type).toBe("form_ready_email");
		expect(outbox.rows[0].status).toBe("pending");
		expect(outbox.rows[0].payload.form_id).toBe(id);
		expect(JSON.stringify(outbox.rows[0].payload)).not.toContain(PII_MARKER);
		expect(JSON.stringify(outbox.rows[0].payload)).not.toContain(
			validForm.name,
		);

		const row = await loadForm(id);
		expect(row.status).toBe("READY");

		const events = await loadEvents(id);
		expect(events).toEqual([{ from_status: "GEOCODED", to_status: "READY" }]);
	});

	it("running it twice sequentially produces exactly one of each row, no error", async () => {
		const id = await insertGeocodedForm("transform-repeat-hash");

		const first = await transformAndPersist(ctx.db, id);
		const second = await transformAndPersist(ctx.db, id);

		expect(first).toEqual({ outcome: "transformed" });
		expect(second).toEqual({ outcome: "skipped" });

		expect(await countByFormId("transformed_forms", id)).toBe(1);
		expect(await countByFormId("outbox", id)).toBe(1);
		expect(await loadEvents(id)).toHaveLength(1);
	});

	it("running it concurrently produces exactly one of each row, no error surfaced", async () => {
		const id = await insertGeocodedForm("transform-race-hash");

		const outcomes = await Promise.all([
			transformAndPersist(ctx.db, id),
			transformAndPersist(ctx.db, id),
		]);

		expect(outcomes.filter((o) => o.outcome === "transformed")).toHaveLength(1);
		expect(
			outcomes.filter(
				(o) => o.outcome === "duplicate" || o.outcome === "skipped",
			),
		).toHaveLength(1);

		expect(await countByFormId("transformed_forms", id)).toBe(1);
		expect(await countByFormId("outbox", id)).toBe(1);
		expect(await loadEvents(id)).toHaveLength(1);

		const row = await loadForm(id);
		expect(row.status).toBe("READY");
	});

	it("rolls back atomically when a fault occurs before commit", async () => {
		const id = await insertGeocodedForm("transform-atomicity-hash");

		await expect(
			transformAndPersist(ctx.db, id, {
				onBeforeCommit: () => {
					throw new Error("injected failure before commit");
				},
			}),
		).rejects.toThrow("injected failure before commit");

		expect(await countByFormId("transformed_forms", id)).toBe(0);
		expect(await countByFormId("outbox", id)).toBe(0);
		expect(await loadEvents(id)).toHaveLength(0);

		const row = await loadForm(id);
		expect(row.status).toBe("GEOCODED");
	});

	it("parks as FAILED_TRANSFORM without leaking PII when the transform throws", async () => {
		const id = await insertGeocodedForm("transform-failure-hash");

		const outcome = await transformAndPersist(ctx.db, id, {
			transform: () => {
				throw new Error("boom: pure transform blew up");
			},
		});

		expect(outcome).toEqual({
			outcome: "failed",
			message: "boom: pure transform blew up",
		});

		const row = await loadForm(id);
		expect(row.status).toBe("FAILED_TRANSFORM");
		expect(row.last_error).toEqual({ message: "boom: pure transform blew up" });
		expect(JSON.stringify(row.last_error)).not.toContain(PII_MARKER);
		expect(JSON.stringify(row.last_error)).not.toContain(validForm.name);

		expect(await countByFormId("transformed_forms", id)).toBe(0);
		expect(await countByFormId("outbox", id)).toBe(0);

		const events = await loadEvents(id);
		expect(events).toEqual([
			{ from_status: "GEOCODED", to_status: "FAILED_TRANSFORM" },
		]);
	});
});
