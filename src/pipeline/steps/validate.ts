import { sql } from "drizzle-orm";
import { Db } from "../../db/client";
import {
	IngestedIssue,
	validateIngested,
} from "../../schemas/ingested/validate";
import { getCurrentIngestedVersion } from "../../schemas/ingested/registry";

export type ValidateOutcome =
	| { outcome: "validated"; version: string; unknownKeys: string[] }
	| { outcome: "failed"; issues: IngestedIssue[] }
	| { outcome: "skipped" };

export async function validateForm(
	db: Db,
	id: string,
): Promise<ValidateOutcome> {
	const loaded = await db.orm.execute<{
		status: string;
		raw_payload: unknown;
	}>(sql`
		select status, raw_payload from forms where id = ${id} limit 1
	`);
	const row = loaded.rows[0];
	if (row === undefined || row.status !== "RECEIVED") {
		return { outcome: "skipped" };
	}

	const version = getCurrentIngestedVersion();
	const result = validateIngested(row.raw_payload, version);

	return db.orm.transaction(async (tx) => {
		if (result.ok) {
			const updated = await tx.execute<{ id: string }>(sql`
				update forms
				set status = 'VALIDATED', schema_version = ${version}, updated_at = now()
				where id = ${id} and status = 'RECEIVED'
				returning id
			`);
			if (updated.rows.length === 0) {
				return { outcome: "skipped" };
			}

			const detail =
				result.unknownKeys.length > 0
					? { unknownKeys: result.unknownKeys }
					: null;
			await tx.execute(sql`
				insert into form_events (form_id, from_status, to_status, detail)
				values (${id}, 'RECEIVED', 'VALIDATED', ${detail === null ? null : JSON.stringify(detail)}::jsonb)
			`);
			return { outcome: "validated", version, unknownKeys: result.unknownKeys };
		}

		const updated = await tx.execute<{ id: string }>(sql`
			update forms
			set status = 'FAILED_VALIDATION', last_error = ${JSON.stringify(result.issues)}::jsonb, updated_at = now()
			where id = ${id} and status = 'RECEIVED'
			returning id
		`);
		if (updated.rows.length === 0) {
			return { outcome: "skipped" };
		}

		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, 'RECEIVED', 'FAILED_VALIDATION', ${null}::jsonb)
		`);
		return { outcome: "failed", issues: result.issues };
	});
}
