import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { validateForm } from "../src/pipeline/steps/validate";
import validForm from "./fixtures/valid-form.json";
import extraFieldForm from "./fixtures/extra-field-form.json";
import missingRequiredForm from "./fixtures/missing-required-form.json";

const PII_MARKER = "1990-03-15";

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

function insertForm(
	contentHash: string,
	rawPayload: unknown,
	status = "RECEIVED",
) {
	return ctx.db.pool
		.query(
			"insert into forms (content_hash, raw_payload, status) values ($1, $2, $3) returning id",
			[contentHash, JSON.stringify(rawPayload), status],
		)
		.then((result) => result.rows[0].id as string);
}

function loadForm(id: string) {
	return ctx.db.pool
		.query(
			"select status, schema_version, last_error from forms where id = $1",
			[id],
		)
		.then((result) => result.rows[0]);
}

function loadEvents(id: string) {
	return ctx.db.pool
		.query(
			"select from_status, to_status, detail from form_events where form_id = $1",
			[id],
		)
		.then((result) => result.rows);
}

describe("validateForm", () => {
	it("moves a valid form to VALIDATED and writes one event", async () => {
		const id = await insertForm("validate-success-hash", validForm);

		const outcome = await validateForm(ctx.db, id);
		expect(outcome).toEqual({
			outcome: "validated",
			version: "v1",
			unknownKeys: [],
		});

		const row = await loadForm(id);
		expect(row.status).toBe("VALIDATED");
		expect(row.schema_version).toBe("v1");

		const events = await loadEvents(id);
		expect(events).toEqual([
			{ from_status: "RECEIVED", to_status: "VALIDATED", detail: null },
		]);
	});

	it("records unknown keys in the event detail", async () => {
		const id = await insertForm("validate-unknown-keys-hash", extraFieldForm);

		const outcome = await validateForm(ctx.db, id);
		expect(outcome).toEqual({
			outcome: "validated",
			version: "v1",
			unknownKeys: ["legacy_notes"],
		});

		const row = await loadForm(id);
		expect(row.status).toBe("VALIDATED");

		const events = await loadEvents(id);
		expect(events[0].detail).toEqual({ unknownKeys: ["legacy_notes"] });
	});

	it("moves an invalid form to FAILED_VALIDATION without leaking PII", async () => {
		const id = await insertForm("validate-failure-hash", missingRequiredForm);

		const outcome = await validateForm(ctx.db, id);
		expect(outcome.outcome).toBe("failed");
		if (outcome.outcome === "failed") {
			expect(outcome.issues.map((issue) => issue.path)).toContain(
				"address.postcode",
			);
		}

		const row = await loadForm(id);
		expect(row.status).toBe("FAILED_VALIDATION");
		expect(JSON.stringify(row.last_error)).not.toContain(PII_MARKER);
		for (const issue of row.last_error) {
			expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
		}

		const events = await loadEvents(id);
		expect(events).toEqual([
			{ from_status: "RECEIVED", to_status: "FAILED_VALIDATION", detail: null },
		]);
	});

	it("running it twice produces exactly one transition and one event", async () => {
		const id = await insertForm("validate-repeat-hash", validForm);

		const first = await validateForm(ctx.db, id);
		const second = await validateForm(ctx.db, id);

		expect(first.outcome).toBe("validated");
		expect(second).toEqual({ outcome: "skipped" });

		const row = await loadForm(id);
		expect(row.status).toBe("VALIDATED");

		const events = await loadEvents(id);
		expect(events).toHaveLength(1);
	});

	it("running it concurrently produces exactly one transition and one event", async () => {
		const id = await insertForm("validate-race-hash", validForm);

		const outcomes = await Promise.all(
			Array.from({ length: 5 }, () => validateForm(ctx.db, id)),
		);

		expect(outcomes.filter((o) => o.outcome === "validated")).toHaveLength(1);
		expect(outcomes.filter((o) => o.outcome === "skipped")).toHaveLength(4);

		const row = await loadForm(id);
		expect(row.status).toBe("VALIDATED");

		const events = await loadEvents(id);
		expect(events).toHaveLength(1);
	});

	it("is a no-op against a form that is not RECEIVED", async () => {
		const id = await insertForm("validate-noop-hash", validForm, "VALIDATED");

		const outcome = await validateForm(ctx.db, id);
		expect(outcome).toEqual({ outcome: "skipped" });

		const row = await loadForm(id);
		expect(row.status).toBe("VALIDATED");

		const events = await loadEvents(id);
		expect(events).toHaveLength(0);
	});
});
