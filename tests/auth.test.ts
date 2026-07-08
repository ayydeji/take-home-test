import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { buildApp } from "../src/app";
import { ApiKeyRing, Scope } from "../src/auth";
import { createLogger } from "../src/log";
import wrongTypeForm from "./fixtures/wrong-type-form.json";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

const KEYS: ApiKeyRing = {
	provider: "provider-key-aaaaaaaaaaaaaaaa",
	bot: "bot-key-bbbbbbbbbbbbbbbbbbbbbbb",
	ops: "ops-key-ccccccccccccccccccccccc",
};

const RANDOM_ID = "00000000-0000-0000-0000-000000000000";

type App = ReturnType<typeof buildApp>;

const ROUTES: {
	name: string;
	scope: Scope;
	issue: (app: App) => request.Test;
}[] = [
	{
		name: "POST /ingest",
		scope: "provider",
		issue: (app) => request(app).post("/ingest").send({}),
	},
	{
		name: "POST /forms/ready",
		scope: "bot",
		issue: (app) => request(app).post("/forms/ready"),
	},
	{
		name: "POST /forms/:id/retry",
		scope: "ops",
		issue: (app) => request(app).post(`/forms/${RANDOM_ID}/retry`),
	},
	{
		name: "GET /forms/:id",
		scope: "ops",
		issue: (app) => request(app).get(`/forms/${RANDOM_ID}`),
	},
];

describe("auth", () => {
	it("returns 401 without a key on every protected route; /health stays open", async () => {
		const app = buildApp(ctx.db, { apiKeys: KEYS });

		for (const route of ROUTES) {
			const response = await route.issue(app);
			expect(response.status, route.name).toBe(401);
		}

		const health = await request(app).get("/health");
		expect(health.status).toBe(200);
	});

	it("enforces the full scope matrix: allowed pairs pass, every other pairing is 403", async () => {
		const app = buildApp(ctx.db, { apiKeys: KEYS });
		const scopes: Scope[] = ["provider", "bot", "ops"];

		for (const testedScope of scopes) {
			for (const route of ROUTES) {
				const response = await route
					.issue(app)
					.set("x-api-key", KEYS[testedScope]);

				if (testedScope === route.scope) {
					expect([401, 403], `${testedScope} on ${route.name}`).not.toContain(
						response.status,
					);
				} else {
					expect(response.status, `${testedScope} on ${route.name}`).toBe(403);
				}
			}
		}
	});

	it("rejects the provider key on POST /forms/ready with 403 specifically", async () => {
		const app = buildApp(ctx.db, { apiKeys: KEYS });

		const response = await request(app)
			.post("/forms/ready")
			.set("x-api-key", KEYS.provider);

		expect(response.status).toBe(403);
	});

	it("rejects a wrong key of equal length to the real key", async () => {
		const app = buildApp(ctx.db, { apiKeys: KEYS });
		const bogus = "x".repeat(KEYS.provider.length);
		expect(bogus.length).toBe(KEYS.provider.length);
		expect(bogus).not.toBe(KEYS.provider);

		const response = await request(app)
			.post("/ingest")
			.set("x-api-key", bogus)
			.send({});

		expect(response.status).toBe(401);
	});

	it("never logs the request body or the api key, even for a payload that will later fail validation", async () => {
		const chunks: string[] = [];
		const capture = {
			write: (chunk: string) => {
				chunks.push(chunk);
				return true;
			},
		};
		const logger = createLogger(capture);
		const app = buildApp(ctx.db, { apiKeys: KEYS, logger });

		const response = await request(app)
			.post("/ingest")
			.set("x-api-key", KEYS.provider)
			.send(wrongTypeForm);

		expect(response.status).toBe(202);

		const logged = chunks.join("");
		expect(logged).not.toContain(wrongTypeForm.date_of_birth);
		expect(logged).not.toContain(wrongTypeForm.name);
		expect(logged).not.toContain(KEYS.provider);
	});
});
