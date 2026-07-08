import { sql } from "drizzle-orm";
import { Db } from "../db/client";

export const DEFAULT_CLAIM_LIMIT = 10;
export const MAX_CLAIM_LIMIT = 50;

// payload is the transformed form handed to FORM-BOT — it is PII and the
// intended handoff body; it must never be logged.
export type ClaimedForm = {
	id: string;
	payload: unknown;
};

export function parseClaimLimit(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) {
		return DEFAULT_CLAIM_LIMIT;
	}
	return Math.min(n, MAX_CLAIM_LIMIT);
}

export async function claimReadyForms(
	db: Db,
	limit: number,
): Promise<ClaimedForm[]> {
	return db.orm.transaction(async (tx) => {
		const claimed = await tx.execute<ClaimedForm>(sql`
			select f.id, t.payload
			from forms f
			join transformed_forms t on t.form_id = f.id
			where f.status = 'READY'
			order by f.received_at
			limit ${limit}
			for update of f skip locked
		`);

		if (claimed.rows.length === 0) {
			return [];
		}

		const ids = claimed.rows.map((row) => row.id);

		// The rows are already locked by the SELECT above, so no CAS status guard
		// is needed here — the lock is what makes the handoff at-most-once.
		// drizzle's sql tag expands a plain JS array param into an `(p1, p2, ...)`
		// list, so `in` (not `= any(...)`) is the correct operator here.
		await tx.execute(sql`
			update forms set status = 'DISPATCHED', updated_at = now()
			where id in ${ids}
		`);

		for (const id of ids) {
			await tx.execute(sql`
				insert into form_events (form_id, from_status, to_status, detail)
				values (${id}, 'READY', 'DISPATCHED', ${null}::jsonb)
			`);
		}

		return claimed.rows;
	});
}
