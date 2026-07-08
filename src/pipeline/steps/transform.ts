import { sql } from "drizzle-orm";
import { Db } from "../../db/client";
import { transformForm } from "../transform";
import { validateIngested } from "../../schemas/ingested/validate";
import { getCurrentIngestedVersion } from "../../schemas/ingested/registry";
import type { IngestedFormV1 } from "../../schemas/ingested/v1";
import type { TransformedFormSchema } from "../../forms/schemas/transformed_schema";

export type TransformOutcome =
	| { outcome: "transformed" }
	| { outcome: "failed"; message: string }
	| { outcome: "duplicate" }
	| { outcome: "skipped" };

export type TransformDeps = {
	transform?: (
		validated: IngestedFormV1,
		geo: { latitude: number; longitude: number },
	) => TransformedFormSchema;
	onBeforeCommit?: () => void | Promise<void>;
};

type FormRow = {
	status: string;
	raw_payload: unknown;
	latitude: string | null;
	longitude: string | null;
	schema_version: string | null;
	received_at: string;
};

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as Record<string, unknown>).code === "23505"
	);
}

async function failTransform(
	db: Db,
	id: string,
	message: string,
): Promise<TransformOutcome> {
	return db.orm.transaction(async (tx) => {
		const updated = await tx.execute<{ id: string }>(sql`
			update forms
			set status = 'FAILED_TRANSFORM', last_error = ${JSON.stringify({ message })}::jsonb, updated_at = now()
			where id = ${id} and status = 'GEOCODED'
			returning id
		`);
		if (updated.rows.length === 0) {
			return { outcome: "skipped" };
		}

		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, 'GEOCODED', 'FAILED_TRANSFORM', ${null}::jsonb)
		`);
		return { outcome: "failed", message };
	});
}

export async function transformAndPersist(
	db: Db,
	id: string,
	deps: TransformDeps = {},
): Promise<TransformOutcome> {
	const loaded = await db.orm.execute<FormRow>(sql`
		select status, raw_payload, latitude, longitude, schema_version, received_at
		from forms where id = ${id} limit 1
	`);
	const row = loaded.rows[0];
	if (row === undefined || row.status !== "GEOCODED") {
		return { outcome: "skipped" };
	}

	const transform = deps.transform ?? transformForm;

	let transformed: TransformedFormSchema;
	try {
		const version = row.schema_version ?? getCurrentIngestedVersion();
		const validated = validateIngested(row.raw_payload, version);
		if (!validated.ok) {
			throw new Error(
				"form marked GEOCODED but raw_payload no longer validates",
			);
		}
		const geo = {
			latitude: Number(row.latitude),
			longitude: Number(row.longitude),
		};
		transformed = transform(validated.data, geo);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "unknown transform error";
		return failTransform(db, id, message);
	}

	try {
		return await db.orm.transaction(async (tx) => {
			await tx.execute(sql`
				insert into transformed_forms (form_id, payload)
				values (${id}, ${JSON.stringify(transformed)}::jsonb)
			`);

			const outboxPayload = {
				form_id: id,
				received_at: new Date(row.received_at).toISOString(),
			};
			await tx.execute(sql`
				insert into outbox (form_id, type, payload)
				values (${id}, 'form_ready_email', ${JSON.stringify(outboxPayload)}::jsonb)
			`);

			const updated = await tx.execute<{ id: string }>(sql`
				update forms
				set status = 'READY', updated_at = now()
				where id = ${id} and status = 'GEOCODED'
				returning id
			`);
			if (updated.rows.length === 0) {
				throw new Error(
					"transform: GEOCODED form vanished mid-transaction after a fresh transformed_forms insert",
				);
			}

			await tx.execute(sql`
				insert into form_events (form_id, from_status, to_status, detail)
				values (${id}, 'GEOCODED', 'READY', ${null}::jsonb)
			`);

			await deps.onBeforeCommit?.();

			return { outcome: "transformed" };
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { outcome: "duplicate" };
		}
		throw err;
	}
}
