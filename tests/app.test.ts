import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app";
import { startTestDb, TestDb } from "./helpers/testDb";

let ctx: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
	ctx = await startTestDb();
	app = buildApp(ctx.db);
});

afterAll(async () => {
	await ctx.stop();
});

describe("POST /ingest", () => {
	it("should return 200", async () => {
		const response = await request(app).post("/ingest");
		expect(response.status).toBe(200);
	});
});
