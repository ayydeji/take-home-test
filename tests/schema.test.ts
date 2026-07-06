import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, startTestDb, TestDb } from "./helpers/testDb";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

function insertForm(contentHash: string) {
	return ctx.db.pool.query(
		"insert into forms (content_hash, raw_payload) values ($1, $2) returning id",
		[contentHash, JSON.stringify({ received: true })],
	);
}

describe("forms constraints and defaults", () => {
	it("rejects a duplicate content_hash with Postgres error 23505", async () => {
		await insertForm("duplicate-content-hash");
		await expect(insertForm("duplicate-content-hash")).rejects.toMatchObject({
			code: "23505",
		});
	});

	it("applies defaults: a minimal insert gets status RECEIVED and timestamps", async () => {
		const { rows } = await ctx.db.pool.query(
			`insert into forms (content_hash, raw_payload) values ($1, $2)
			 returning status, received_at, updated_at`,
			["defaults-content-hash", JSON.stringify({ received: true })],
		);
		expect(rows[0].status).toBe("RECEIVED");
		expect(rows[0].received_at).not.toBeNull();
		expect(rows[0].updated_at).not.toBeNull();
	});
});

describe("transformed_forms constraints", () => {
	it("rejects a second row for the same form_id with 23505", async () => {
		const { rows } = await insertForm("transform-content-hash");
		const formId = rows[0].id;

		const insertTransformed = () =>
			ctx.db.pool.query(
				"insert into transformed_forms (form_id, payload) values ($1, $2)",
				[formId, JSON.stringify({ transformed: true })],
			);

		await insertTransformed();
		await expect(insertTransformed()).rejects.toMatchObject({ code: "23505" });
	});
});

describe("migrations", () => {
	it("is a no-op when run twice, not an error", async () => {
		const countMigrations = async () => {
			const { rows } = await ctx.db.pool.query(
				"select count(*)::int as n from drizzle.__drizzle_migrations",
			);
			return rows[0].n as number;
		};

		const before = await countMigrations();
		await expect(runMigrations(ctx.db.orm)).resolves.toBeUndefined();
		expect(await countMigrations()).toBe(before);
	});
});
