import { sql } from "drizzle-orm";
import { Db } from "../db/client";
import { formStatus } from "../db/schema";

export type Stats = {
	counts: Record<string, number>;
	oldest_non_terminal_age_seconds: number | null;
	outbox_pending: number;
};

export async function getStats(db: Db): Promise<Stats> {
	const counts: Record<string, number> = {};
	for (const status of formStatus.enumValues) {
		counts[status] = 0;
	}

	const countRows = await db.orm.execute<{ status: string; n: number }>(sql`
		select status, count(*)::int as n from forms group by status
	`);
	for (const row of countRows.rows) {
		counts[row.status] = row.n;
	}

	const ageRow = await db.orm.execute<{ age: number | null }>(sql`
		select floor(extract(epoch from (now() - min(received_at))))::int as age
		from forms
		where status in ('RECEIVED', 'VALIDATED', 'GEOCODED')
	`);

	const outboxRow = await db.orm.execute<{ n: number }>(sql`
		select count(*)::int as n from outbox where status = 'pending'
	`);

	return {
		counts,
		oldest_non_terminal_age_seconds: ageRow.rows[0]?.age ?? null,
		outbox_pending: outboxRow.rows[0]?.n ?? 0,
	};
}
