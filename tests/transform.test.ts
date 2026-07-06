import { describe, expect, it } from "vitest";
import { validateIngested } from "../src/schemas/ingested/validate";
import { transformedV1 } from "../src/schemas/transformed/v1";
import { transformForm } from "../src/pipeline/transform";
import validForm from "./fixtures/valid-form.json";

const GEO = { latitude: -5.05, longitude: 50.05 };

function validatedInput() {
	const result = validateIngested(validForm);
	if (!result.ok) {
		throw new Error("fixture valid-form.json failed validation");
	}
	return result.data;
}

describe("transformForm", () => {
	it("maps a validated form plus coordinates to the exact target shape", () => {
		expect(transformForm(validatedInput(), GEO)).toEqual({
			sessionId: "sess_9f2a7c",
			applicationReference: "GP-REG-2026-000042",
			firstName: "Jordan",
			lastName: "Alexander Rivera",
			email: "jordan.rivera@example.com",
			gender: "prefer-not-to-say",
			dateOfBirth: new Date("1990-03-15"),
			phoneNumber: "+44 20 7946 0958",
			mobileNumber: "+44 7700 900123",
			addressLine1: "12 Kingsway",
			addressLine2: "Holborn",
			addressLine3: "Camden",
			postcode: "WC2B 6NH",
			country: "United Kingdom",
			longitude: 50.05,
			latitude: -5.05,
		});
	});

	it("produces output that parses against the transformed schema", () => {
		expect(() =>
			transformedV1.parse(transformForm(validatedInput(), GEO)),
		).not.toThrow();
	});

	it("is deterministic: same input yields deeply equal output", () => {
		const input = validatedInput();
		expect(transformForm(input, GEO)).toEqual(transformForm(input, GEO));
	});
});
