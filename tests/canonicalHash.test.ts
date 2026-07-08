import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/ingest/canonicalHash";

describe("canonicalHash", () => {
	it("is deterministic for the same input", () => {
		const payload = { a: 1, b: { c: 2, d: [1, 2, 3] } };
		expect(canonicalHash(payload)).toBe(canonicalHash(payload));
	});

	it("is unaffected by top-level key order", () => {
		const a = { session_id: "s1", name: "Jordan", email: "j@example.com" };
		const b = { email: "j@example.com", name: "Jordan", session_id: "s1" };
		expect(canonicalHash(a)).toBe(canonicalHash(b));
	});

	it("is unaffected by nested key order", () => {
		const a = { address: { postcode: "WC2B 6NH", country: "United Kingdom" } };
		const b = { address: { country: "United Kingdom", postcode: "WC2B 6NH" } };
		expect(canonicalHash(a)).toBe(canonicalHash(b));
	});

	it("is sensitive to array order", () => {
		const a = { tags: ["a", "b"] };
		const b = { tags: ["b", "a"] };
		expect(canonicalHash(a)).not.toBe(canonicalHash(b));
	});

	it("produces different hashes for different values", () => {
		expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
	});
});
