import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app";
import { createDb } from "../src/db/client";

const db = createDb();
const app = buildApp(db);

afterAll(async () => {
	await db.pool.end();
});

describe("GET /health", () => {
	it("returns ok when the database is reachable", async () => {
		const response = await request(app).get("/health");
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ status: "ok" });
	});
});
