import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app";
import { startTestDb, TestDb } from "./helpers/testDb";
import { parseClaimLimit } from "../src/forms/claimReadyForms";

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

let ctx: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
	ctx = await startTestDb();
	app = buildApp(ctx.db);
});

afterAll(async () => {
	await ctx.stop();
});

async function insertForm(contentHash: string, status: string) {
	const result = await ctx.db.pool.query(
		"insert into forms (content_hash, raw_payload, status) values ($1, $2, $3) returning id",
		[contentHash, JSON.stringify({}), status],
	);
	return result.rows[0].id as string;
}

async function insertReadyForm(contentHash: string, payload: unknown) {
	const id = await insertForm(contentHash, "READY");
	await ctx.db.pool.query(
		"insert into transformed_forms (form_id, payload) values ($1, $2)",
		[id, JSON.stringify(payload)],
	);
	return id;
}

function loadForm(id: string) {
	return ctx.db.pool
		.query("select status from forms where id = $1", [id])
		.then((result) => result.rows[0]);
}

function loadEvents(id: string) {
	return ctx.db.pool
		.query(
			"select from_status, to_status from form_events where form_id = $1 order by created_at asc",
			[id],
		)
		.then((result) => result.rows);
}

async function claim(limit?: number) {
	const req = request(app).post("/forms/ready");
	return limit === undefined ? req : req.query({ limit });
}

async function drainReady() {
	for (;;) {
		const response = await claim(50);
		if (response.status !== 200) {
			throw new Error(
				`drainReady: unexpected ${response.status} ${JSON.stringify(response.body)}`,
			);
		}
		if (response.body.length === 0) {
			return;
		}
	}
}

describe("parseClaimLimit", () => {
	it("defaults to 10 when missing or invalid", () => {
		expect(parseClaimLimit(undefined)).toBe(10);
		expect(parseClaimLimit("0")).toBe(10);
		expect(parseClaimLimit("-3")).toBe(10);
		expect(parseClaimLimit("abc")).toBe(10);
		expect(parseClaimLimit("7.5")).toBe(10);
	});

	it("respects a valid limit", () => {
		expect(parseClaimLimit("20")).toBe(20);
		expect(parseClaimLimit("50")).toBe(50);
	});

	it("caps at 50", () => {
		expect(parseClaimLimit("100")).toBe(50);
	});
});

describe("POST /forms/ready", () => {
	it("claims only READY forms with a committed transformed payload", async () => {
		await drainReady();

		for (const status of ALL_STATUSES) {
			if (status !== "READY") {
				await insertForm(`ready-status-${status}`, status);
			}
		}
		const readyWithoutTransform = await insertForm(
			"ready-no-transform",
			"READY",
		);
		const payload = { firstName: "Jordan", lastName: "Rivera" };
		const readyId = await insertReadyForm("ready-with-transform", payload);

		const response = await claim(50);

		expect(response.status).toBe(200);
		expect(response.body).toEqual([{ id: readyId, payload }]);

		expect((await loadForm(readyId)).status).toBe("DISPATCHED");
		expect(await loadEvents(readyId)).toEqual([
			{ from_status: "READY", to_status: "DISPATCHED" },
		]);

		expect((await loadForm(readyWithoutTransform)).status).toBe("READY");
		expect(await loadEvents(readyWithoutTransform)).toEqual([]);
	});

	it("returns an empty array on a second call", async () => {
		await drainReady();

		const id = await insertReadyForm("ready-idempotent", { a: 1 });

		const first = await claim(10);
		expect(first.body).toEqual([{ id, payload: { a: 1 } }]);

		const second = await claim(10);
		expect(second.status).toBe(200);
		expect(second.body).toEqual([]);

		expect((await loadForm(id)).status).toBe("DISPATCHED");
		expect(await loadEvents(id)).toHaveLength(1);
	});

	it("resolves a 15-form race across two parallel claims to a disjoint, exhaustive split", async () => {
		await drainReady();

		const seeded = new Set<string>();
		for (let i = 0; i < 15; i++) {
			const id = await insertReadyForm(`ready-race-${i}`, { i });
			seeded.add(id);
		}

		const [first, second] = await Promise.all([claim(10), claim(10)]);

		const firstIds: string[] = first.body.map((f: { id: string }) => f.id);
		const secondIds: string[] = second.body.map((f: { id: string }) => f.id);

		const intersection = firstIds.filter((id) => secondIds.includes(id));
		expect(intersection).toEqual([]);

		const union = new Set([...firstIds, ...secondIds]);
		expect(union.size).toBe(15);
		expect(union).toEqual(seeded);

		for (const id of union) {
			expect((await loadForm(id)).status).toBe("DISPATCHED");
			expect(await loadEvents(id)).toEqual([
				{ from_status: "READY", to_status: "DISPATCHED" },
			]);
		}
	});

	it("respects the limit and caps subsequent calls to the remainder", async () => {
		await drainReady();

		const ids = [
			await insertReadyForm("ready-limit-1", { i: 1 }),
			await insertReadyForm("ready-limit-2", { i: 2 }),
			await insertReadyForm("ready-limit-3", { i: 3 }),
		];

		const first = await claim(2);
		expect(first.body).toHaveLength(2);

		const second = await claim(2);
		expect(second.body).toHaveLength(1);

		const claimedIds = [...first.body, ...second.body].map(
			(f: { id: string }) => f.id,
		);
		expect(new Set(claimedIds)).toEqual(new Set(ids));
	});
});
