import { sql } from "drizzle-orm";
import { Db } from "../db/client";
import { Geocoder, defaultGeocoder } from "../geocoder/client";
import { validateForm } from "./steps/validate";
import { geocodeForm } from "./steps/geocode";
import { transformAndPersist } from "./steps/transform";

export type PipelineRunner = (formId: string) => Promise<void>;

const PROCESSABLE_STATUSES = new Set(["RECEIVED", "VALIDATED", "GEOCODED"]);

async function loadStatus(db: Db, formId: string): Promise<string | undefined> {
	const result = await db.orm.execute<{ status: string }>(sql`
		select status from forms where id = ${formId} limit 1
	`);
	return result.rows[0]?.status;
}

export async function runPipeline(
	db: Db,
	formId: string,
	deps: { geocoder: Geocoder },
): Promise<void> {
	let previousStatus: string | undefined;

	for (;;) {
		const status = await loadStatus(db, formId);

		if (status === undefined || !PROCESSABLE_STATUSES.has(status)) {
			return;
		}
		if (status === previousStatus) {
			return;
		}
		previousStatus = status;

		if (status === "RECEIVED") {
			await validateForm(db, formId);
		} else if (status === "VALIDATED") {
			await geocodeForm(db, formId, deps.geocoder);
		} else {
			await transformAndPersist(db, formId);
		}
	}
}

export function createDefaultRunner(db: Db): PipelineRunner {
	return (formId: string) =>
		runPipeline(db, formId, { geocoder: defaultGeocoder });
}
