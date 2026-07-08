import { sql } from "drizzle-orm";
import { Db } from "../db/client";

export type FormView = {
	id: string;
	status: string;
	schema_version: string | null;
	last_error: unknown;
	received_at: string;
	updated_at: string;
	has_transformed: boolean;
};

type FormRow = {
	id: string;
	status: string;
	schema_version: string | null;
	last_error: unknown;
	// drizzle's raw sql executor returns timestamptz as Postgres text, not a Date.
	received_at: string;
	updated_at: string;
	has_transformed: boolean;
};

export async function getFormView(
	db: Db,
	id: string,
): Promise<FormView | null> {
	// raw_payload is patient PII: this endpoint is for operational triage, not data
	// access, so only these operational columns are ever selected.
	const result = await db.orm.execute<FormRow>(sql`
		select
			f.id,
			f.status,
			f.schema_version,
			f.last_error,
			f.received_at,
			f.updated_at,
			exists(select 1 from transformed_forms tf where tf.form_id = f.id) as has_transformed
		from forms f
		where f.id = ${id}
		limit 1
	`);

	const row = result.rows[0];
	if (row === undefined) {
		return null;
	}

	return {
		id: row.id,
		status: row.status,
		schema_version: row.schema_version,
		last_error: row.last_error ?? null,
		received_at: new Date(row.received_at).toISOString(),
		updated_at: new Date(row.updated_at).toISOString(),
		has_transformed: row.has_transformed,
	};
}
