import { z } from "zod";
import { ingestedV1 } from "./v1";

export const CURRENT_INGESTED_VERSION = "v1";

const schemas = new Map<string, z.ZodTypeAny>([["v1", ingestedV1]]);

let currentVersion = CURRENT_INGESTED_VERSION;

export function registerIngestedSchema(
	version: string,
	schema: z.ZodTypeAny,
): void {
	schemas.set(version, schema);
}

export function getIngestedSchema(version: string): z.ZodTypeAny {
	const schema = schemas.get(version);
	if (!schema) {
		throw new Error(`No ingested schema registered for version "${version}"`);
	}
	return schema;
}

export function getCurrentIngestedVersion(): string {
	return currentVersion;
}

export function setCurrentIngestedVersion(version: string): void {
	if (!schemas.has(version)) {
		throw new Error(
			`Cannot set current ingested version to unregistered "${version}"`,
		);
	}
	currentVersion = version;
}
