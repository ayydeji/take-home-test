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

function insertForm(
	contentHash: string,
	overrides: {
		rawPayload?: unknown;
		schemaVersion?: string | null;
		lastError?: unknown;
	} = {},
) {
	return ctx.db.pool
		.query(
			`insert into forms (content_hash, raw_payload, schema_version, last_error)
			 values ($1, $2, $3, $4)
			 returning id`,
			[
				contentHash,
				JSON.stringify(overrides.rawPayload ?? { received: true }),
				overrides.schemaVersion ?? null,
				overrides.lastError !== undefined
					? JSON.stringify(overrides.lastError)
					: null,
			],
		)
		.then((result) => result.rows[0].id as string);
}

describe("GET /forms/:id", () => {
	it("returns exactly the operational view, with has_transformed false", async () => {
		const id = await insertForm("view-shape-hash", {
			schemaVersion: "v1",
			lastError: { path: "address.postcode", code: "invalid_type" },
		});

		const response = await request(app).get(`/forms/${id}`);

		expect(response.status).toBe(200);
		expect(response.body).toEqual({
			id,
			status: "RECEIVED",
			schema_version: "v1",
			last_error: { path: "address.postcode", code: "invalid_type" },
			received_at: expect.any(String),
			updated_at: expect.any(String),
			has_transformed: false,
		});
	});

	it("reports has_transformed true once a transformed_forms row exists", async () => {
		const id = await insertForm("view-transformed-hash");
		await ctx.db.pool.query(
			"insert into transformed_forms (form_id, payload) values ($1, $2)",
			[id, JSON.stringify({ transformed: true })],
		);

		const response = await request(app).get(`/forms/${id}`);

		expect(response.status).toBe(200);
		expect(response.body.has_transformed).toBe(true);
	});

	it("returns 404 for a well-formed id that does not exist", async () => {
		const response = await request(app).get(
			"/forms/00000000-0000-0000-0000-000000000000",
		);
		expect(response.status).toBe(404);
	});

	it("returns 400 for a non-uuid id", async () => {
		const response = await request(app).get("/forms/not-a-uuid");
		expect(response.status).toBe(400);
	});

	it("never exposes raw_payload or the PII it contains", async () => {
		const id = await insertForm("view-pii-hash", { rawPayload: validForm });

		const response = await request(app).get(`/forms/${id}`);

		expect(response.body).not.toHaveProperty("raw_payload");
		const serialized = JSON.stringify(response.body);
		expect(serialized).not.toContain(validForm.date_of_birth);
		expect(serialized).not.toContain(validForm.name);
	});
});
