import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app";
import { startTestDb, TestDb } from "./helpers/testDb";
import validForm from "./fixtures/valid-form.json";

let ctx: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
	ctx = await startTestDb();
	app = buildApp(ctx.db);
});

afterAll(async () => {
	await ctx.stop();
});

function countRows(table: string) {
	return ctx.db.pool
		.query(`select count(*)::int as n from ${table}`)
		.then((result) => result.rows[0].n as number);
}

describe("POST /ingest", () => {
	it("stores a new payload and writes one event", async () => {
		const response = await request(app).post("/ingest").send(validForm);

		expect(response.status).toBe(202);
		expect(response.body).toEqual({ id: expect.any(String) });

		const { rows } = await ctx.db.pool.query(
			"select status, raw_payload from forms where id = $1",
			[response.body.id],
		);
		expect(rows[0].status).toBe("RECEIVED");
		expect(rows[0].raw_payload).toEqual(validForm);

		const events = await ctx.db.pool.query(
			"select from_status, to_status from form_events where form_id = $1",
			[response.body.id],
		);
		expect(events.rows).toEqual([{ from_status: null, to_status: "RECEIVED" }]);
	});

	it("treats a repeat post as a duplicate: one row, same id, 200", async () => {
		const payload = { ...validForm, session_id: "sess_dup_01" };

		const first = await request(app).post("/ingest").send(payload);
		const second = await request(app).post("/ingest").send(payload);

		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		expect(second.body).toEqual({ id: first.body.id, duplicate: true });

		const { rows } = await ctx.db.pool.query(
			"select count(*)::int as n from forms where content_hash = (select content_hash from forms where id = $1)",
			[first.body.id],
		);
		expect(rows[0].n).toBe(1);

		const events = await ctx.db.pool.query(
			"select count(*)::int as n from form_events where form_id = $1",
			[first.body.id],
		);
		expect(events.rows[0].n).toBe(1);
	});

	it("treats reordered keys as a duplicate", async () => {
		const payload = { ...validForm, session_id: "sess_reorder_01" };
		const reordered = Object.fromEntries(Object.entries(payload).reverse());

		const first = await request(app).post("/ingest").send(payload);
		const second = await request(app).post("/ingest").send(reordered);

		expect(second.status).toBe(200);
		expect(second.body).toEqual({ id: first.body.id, duplicate: true });
	});

	it("resolves a 10-way identical race to exactly one row and one event", async () => {
		const payload = { ...validForm, session_id: "sess_race_01" };

		const responses = await Promise.all(
			Array.from({ length: 10 }, () =>
				request(app).post("/ingest").send(payload),
			),
		);

		const ids = new Set(responses.map((r) => r.body.id));
		expect(ids.size).toBe(1);

		const [id] = ids;
		const forms = await ctx.db.pool.query(
			"select count(*)::int as n from forms where content_hash = (select content_hash from forms where id = $1)",
			[id],
		);
		expect(forms.rows[0].n).toBe(1);

		const events = await ctx.db.pool.query(
			"select count(*)::int as n from form_events where form_id = $1",
			[id],
		);
		expect(events.rows[0].n).toBe(1);
	});

	it("parks a provider_form_id collision as CONFLICT, storing both rows", async () => {
		const first = {
			...validForm,
			session_id: "sess_conflict_a",
			provider_form_id: "prov-123",
		};
		const second = {
			...validForm,
			session_id: "sess_conflict_b",
			provider_form_id: "prov-123",
		};

		const beforeCount = await countRows("forms");

		const firstResponse = await request(app).post("/ingest").send(first);
		const secondResponse = await request(app).post("/ingest").send(second);

		expect(firstResponse.status).toBe(202);
		expect(secondResponse.status).toBe(202);
		expect(secondResponse.body).toEqual({
			id: expect.any(String),
			conflict: true,
		});

		const { rows } = await ctx.db.pool.query(
			"select status from forms where id = $1",
			[secondResponse.body.id],
		);
		expect(rows[0].status).toBe("CONFLICT");

		const events = await ctx.db.pool.query(
			"select detail from form_events where form_id = $1",
			[secondResponse.body.id],
		);
		expect(events.rows[0].detail).toEqual({
			reason: "provider_form_id collision",
			other_form_id: firstResponse.body.id,
		});

		expect(await countRows("forms")).toBe(beforeCount + 2);
	});

	it("rejects a body over 1MB with 413", async () => {
		const oversized = { ...validForm, padding: "x".repeat(1_100_000) };

		const response = await request(app).post("/ingest").send(oversized);

		expect(response.status).toBe(413);
	});
});
