import { describe, expect, it } from "vitest";
import { createGeocoder } from "../src/geocoder/client";

const FAST_CFG = { timeoutMs: 20, attempts: 3, backoffMs: 1 };
const COORDS = { latitude: 51.5, longitude: -0.1 };

describe("createGeocoder", () => {
	it("succeeds on the first attempt with a single call", async () => {
		let calls = 0;
		const geocoder = createGeocoder(async () => {
			calls++;
			return { statusCode: 200, body: COORDS };
		}, FAST_CFG);

		const result = await geocoder.geocode("WC2B 6NH");

		expect(result).toEqual({ ok: true, coordinates: COORDS });
		expect(calls).toBe(1);
	});

	it("retries after a failure and succeeds within the attempt budget", async () => {
		let calls = 0;
		const geocoder = createGeocoder(async () => {
			calls++;
			if (calls < 2) {
				return { statusCode: 500, body: undefined };
			}
			return { statusCode: 200, body: COORDS };
		}, FAST_CFG);

		const result = await geocoder.geocode("WC2B 6NH");

		expect(result).toEqual({ ok: true, coordinates: COORDS });
		expect(calls).toBe(2);
		expect(calls).toBeLessThanOrEqual(FAST_CFG.attempts);
	});

	it("exhausts the attempt budget and reports upstream_error", async () => {
		let calls = 0;
		const geocoder = createGeocoder(async () => {
			calls++;
			return { statusCode: 500, body: undefined };
		}, FAST_CFG);

		const result = await geocoder.geocode("WC2B 6NH");

		expect(result).toEqual({ ok: false, reason: "upstream_error" });
		expect(calls).toBe(FAST_CFG.attempts);
	});

	it("times out a lookup that never resolves, without hanging", async () => {
		const geocoder = createGeocoder(() => new Promise(() => {}), {
			timeoutMs: 10,
			attempts: 1,
			backoffMs: 1,
		});

		const result = await geocoder.geocode("WC2B 6NH");

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});
});
