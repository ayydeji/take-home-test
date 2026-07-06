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

describe("GET /health", () => {
	it("returns ok when the database is reachable", async () => {
		const response = await request(app).get("/health");
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ status: "ok" });
	});
});
