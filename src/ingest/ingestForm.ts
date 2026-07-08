import { sql } from "drizzle-orm";
import { Db } from "../db/client";
import { canonicalHash } from "./canonicalHash";

export type IngestResult =
	| { outcome: "created"; id: string }
	| { outcome: "duplicate"; id: string }
	| { outcome: "conflict"; id: string; otherFormId: string };

function extractProviderFormId(payload: unknown): string | null {
	if (payload === null || typeof payload !== "object") {
		return null;
	}
	const value = (payload as Record<string, unknown>).provider_form_id;
	return typeof value === "string" ? value : null;
}

export async function ingestForm(
	db: Db,
	payload: unknown,
): Promise<IngestResult> {
	const hash = canonicalHash(payload);
	const providerFormId = extractProviderFormId(payload);

	return db.orm.transaction(async (tx) => {
		let otherFormId: string | null = null;

		if (providerFormId !== null) {
			const collision = await tx.execute<{ id: string }>(sql`
				select id from forms
				where provider_form_id = ${providerFormId}
				and content_hash <> ${hash}
				limit 1
			`);
			otherFormId = collision.rows[0]?.id ?? null;
		}

		const status = otherFormId !== null ? "CONFLICT" : "RECEIVED";
		const detail =
			otherFormId !== null
				? { reason: "provider_form_id collision", other_form_id: otherFormId }
				: null;

		const inserted = await tx.execute<{ id: string }>(sql`
			insert into forms (provider_form_id, content_hash, raw_payload, status)
			values (${providerFormId}, ${hash}, ${JSON.stringify(payload)}::jsonb, ${status})
			on conflict (content_hash) do nothing
			returning id
		`);

		if (inserted.rows.length === 0) {
			const existing = await tx.execute<{ id: string }>(sql`
				select id from forms where content_hash = ${hash} limit 1
			`);
			const id = existing.rows[0]?.id;
			if (id === undefined) {
				throw new Error(
					"ingest: expected a conflicting form row but found none",
				);
			}
			return { outcome: "duplicate", id };
		}

		const id = inserted.rows[0].id;

		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, ${null}, ${status}, ${detail === null ? null : JSON.stringify(detail)}::jsonb)
		`);

		return otherFormId !== null
			? { outcome: "conflict", id, otherFormId }
			: { outcome: "created", id };
	});
}
