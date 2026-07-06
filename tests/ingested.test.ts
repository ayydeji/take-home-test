import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerIngestedSchema } from "../src/schemas/ingested/registry";
import { validateIngested } from "../src/schemas/ingested/validate";
import validForm from "./fixtures/valid-form.json";
import extraFieldForm from "./fixtures/extra-field-form.json";
import missingRequiredForm from "./fixtures/missing-required-form.json";
import wrongTypeForm from "./fixtures/wrong-type-form.json";

const MARKER = "1990-03-15";

describe("validateIngested", () => {
	it("accepts a valid form and echoes the parsed data", () => {
		const result = validateIngested(validForm);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.session_id).toBe("sess_9f2a7c");
			expect(result.data.date_of_birth).toBe(MARKER);
			expect(result.data.address.postcode).toBe("WC2B 6NH");
			expect(result.unknownKeys).toEqual([]);
		}
	});

	it("accepts an extra-field form and reports the unknown key", () => {
		const result = validateIngested(extraFieldForm);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.unknownKeys).toEqual(["legacy_notes"]);
		}
	});

	it("rejects a missing-required form with the correct issue path", () => {
		const result = validateIngested(missingRequiredForm);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.path)).toContain(
				"address.postcode",
			);
		}
	});

	it("rejects a wrong-type form with the correct issue code", () => {
		const result = validateIngested(wrongTypeForm);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain(
				"invalid_enum_value",
			);
		}
	});

	it("never leaks received values into issues", () => {
		for (const fixture of [missingRequiredForm, wrongTypeForm]) {
			const result = validateIngested(fixture);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(JSON.stringify(result.issues)).not.toContain(MARKER);
				for (const issue of result.issues) {
					expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
				}
			}
		}
	});

	it("validates against a newly registered version", () => {
		registerIngestedSchema(
			"v2-test",
			z.object({ ping: z.string() }).passthrough(),
		);
		const result = validateIngested({ ping: "pong" }, "v2-test");
		expect(result.ok).toBe(true);
	});
});
