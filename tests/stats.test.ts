import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { buildApp } from "../src/app";
import { ApiKeyRing } from "../src/auth";

let ctx: TestDb;
let counter = 0;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

beforeEach(async () => {
	await ctx.db.pool.query(
		"truncate table forms, form_events, transformed_forms, outbox restart identity cascade",
	);
});

function insertForm(status: string, ageSeconds = 0) {
	counter += 1;
	return ctx.db.pool.query(
		`insert into forms (content_hash, raw_payload, status, received_at)
		 values ($1, $2, $3, now() - ($4 * interval '1 second'))`,
		[
			`stats-hash-${counter}`,
			JSON.stringify({ n: counter }),
			status,
			ageSeconds,
		],
	);
}

// Each call also inserts a READY form (outbox.form_id is a required FK), so
// callers must fold these into the expected READY count.
async function insertOutbox(status: string) {
	const form = await ctx.db.pool.query(
		`insert into forms (content_hash, raw_payload, status)
		 values ($1, $2, 'READY') returning id`,
		[`stats-outbox-hash-${++counter}`, JSON.stringify({ n: counter })],
	);
	await ctx.db.pool.query(
		"insert into outbox (form_id, type, payload, status) values ($1, 'form_ready_email', $2, $3)",
		[form.rows[0].id, JSON.stringify({ form_id: form.rows[0].id }), status],
	);
}

const ALL_STATUSES = [
	"RECEIVED",
	"VALIDATED",
	"GEOCODED",
	"READY",
	"DISPATCHED",
	"CONFLICT",
	"FAILED_VALIDATION",
	"FAILED_GEOCODING",
	"FAILED_TRANSFORM",
];

describe("GET /stats", () => {
	it("reports exact counts, the oldest non-terminal age, and the outbox backlog", async () => {
		await insertForm("RECEIVED", 300);
		await insertForm("RECEIVED", 10);
		await insertForm("RECEIVED", 0);
		await insertForm("FAILED_VALIDATION");
		await insertForm("FAILED_VALIDATION");
		await insertForm("READY", 9999);
		await insertOutbox("pending");
		await insertOutbox("pending");
		await insertOutbox("sent");

		const app = buildApp(ctx.db);
		const response = await request(app).get("/stats");

		expect(response.status).toBe(200);
		expect(response.body.counts).toEqual({
			RECEIVED: 3,
			VALIDATED: 0,
			GEOCODED: 0,
			READY: 4,
			DISPATCHED: 0,
			CONFLICT: 0,
			FAILED_VALIDATION: 2,
			FAILED_GEOCODING: 0,
			FAILED_TRANSFORM: 0,
		});
		expect(response.body.oldest_non_terminal_age_seconds).toBe(300);
		expect(response.body.outbox_pending).toBe(2);
	});

	it("returns zero counts and a null age for an empty database", async () => {
		const app = buildApp(ctx.db);
		const response = await request(app).get("/stats");

		expect(response.status).toBe(200);
		const expectedCounts: Record<string, number> = {};
		for (const status of ALL_STATUSES) {
			expectedCounts[status] = 0;
		}
		expect(response.body.counts).toEqual(expectedCounts);
		expect(response.body.oldest_non_terminal_age_seconds).toBeNull();
		expect(response.body.outbox_pending).toBe(0);
	});

	it("is ops-scoped: ops key allowed, provider key 403, no key 401", async () => {
		const KEYS: ApiKeyRing = {
			provider: "provider-key-aaaaaaaaaaaaaaaa",
			bot: "bot-key-bbbbbbbbbbbbbbbbbbbbbbb",
			ops: "ops-key-ccccccccccccccccccccccc",
		};
		const app = buildApp(ctx.db, { apiKeys: KEYS });

		const withOps = await request(app).get("/stats").set("x-api-key", KEYS.ops);
		expect(withOps.status).toBe(200);

		const withProvider = await request(app)
			.get("/stats")
			.set("x-api-key", KEYS.provider);
		expect(withProvider.status).toBe(403);

		const withoutKey = await request(app).get("/stats");
		expect(withoutKey.status).toBe(401);
	});
});
