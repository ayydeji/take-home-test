import { sql } from "drizzle-orm";
import { Db } from "../db/client";

const RESET_MAPPING: Record<string, string> = {
	FAILED_VALIDATION: "RECEIVED",
	FAILED_GEOCODING: "VALIDATED",
	FAILED_TRANSFORM: "GEOCODED",
};

export type RetryOutcome =
	| { outcome: "retried"; from: string; to: string }
	| { outcome: "not_failed"; status: string }
	| { outcome: "not_found" }
	| { outcome: "race_lost" };

export async function retryForm(db: Db, id: string): Promise<RetryOutcome> {
	const loaded = await db.orm.execute<{ status: string }>(sql`
		select status from forms where id = ${id} limit 1
	`);
	const row = loaded.rows[0];
	if (row === undefined) {
		return { outcome: "not_found" };
	}

	const mapped = RESET_MAPPING[row.status];
	if (mapped === undefined) {
		return { outcome: "not_failed", status: row.status };
	}

	return db.orm.transaction(async (tx) => {
		const updated = await tx.execute<{ id: string }>(sql`
			update forms
			set status = ${mapped}::form_status, last_error = null, updated_at = now()
			where id = ${id} and status = ${row.status}::form_status
			returning id
		`);
		if (updated.rows.length === 0) {
			return { outcome: "race_lost" };
		}

		const detail = { retry_from: row.status };
		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, ${row.status}, ${mapped}, ${JSON.stringify(detail)}::jsonb)
		`);

		return { outcome: "retried", from: row.status, to: mapped };
	});
}
