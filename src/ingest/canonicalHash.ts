import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

export function canonicalHash(payload: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(payload)))
		.digest("hex");
}
