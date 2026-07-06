import { z } from "zod";
import type { IngestedFormV1 } from "./v1";
import { getCurrentIngestedVersion, getIngestedSchema } from "./registry";

export type IngestedIssue = { path: string; code: string };

export type ValidateIngestedResult =
	| { ok: true; data: IngestedFormV1; unknownKeys: string[] }
	| { ok: false; issues: IngestedIssue[] };

// Path and code only. Never spread the issue: a received value must be structurally unreachable here.
function sanitizeIssues(error: z.ZodError): IngestedIssue[] {
	return error.issues.map(({ path, code }) => ({ path: path.join("."), code }));
}

function topLevelUnknownKeys(schema: z.ZodTypeAny, data: unknown): string[] {
	if (
		!(schema instanceof z.ZodObject) ||
		data === null ||
		typeof data !== "object"
	) {
		return [];
	}
	const known = new Set(Object.keys(schema.shape));
	return Object.keys(data).filter((key) => !known.has(key));
}

export function validateIngested(
	payload: unknown,
	version: string = getCurrentIngestedVersion(),
): ValidateIngestedResult {
	const schema = getIngestedSchema(version);
	const result = schema.safeParse(payload);
	if (!result.success) {
		return { ok: false, issues: sanitizeIssues(result.error) };
	}
	return {
		ok: true,
		data: result.data as IngestedFormV1,
		unknownKeys: topLevelUnknownKeys(schema, result.data),
	};
}
