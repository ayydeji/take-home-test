import { sql } from "drizzle-orm";
import { Db } from "../../db/client";
import { Geocoder } from "../../geocoder/client";

export type GeocodeOutcome =
	| { outcome: "geocoded"; cached: boolean }
	| { outcome: "failed"; reason: string }
	| { outcome: "skipped" };

type FormRow = {
	status: string;
	latitude: string | null;
	longitude: string | null;
	raw_payload: unknown;
};

function extractPostcode(rawPayload: unknown): string | undefined {
	if (rawPayload === null || typeof rawPayload !== "object") {
		return undefined;
	}
	const address = (rawPayload as Record<string, unknown>).address;
	if (address === null || typeof address !== "object") {
		return undefined;
	}
	const postcode = (address as Record<string, unknown>).postcode;
	return typeof postcode === "string" ? postcode : undefined;
}

export async function geocodeForm(
	db: Db,
	id: string,
	geocoder: Geocoder,
): Promise<GeocodeOutcome> {
	const loaded = await db.orm.execute<FormRow>(sql`
		select status, latitude, longitude, raw_payload from forms where id = ${id} limit 1
	`);
	const row = loaded.rows[0];
	if (row === undefined || row.status !== "VALIDATED") {
		return { outcome: "skipped" };
	}

	if (row.latitude !== null && row.longitude !== null) {
		return casToGeocoded(db, id, null, true);
	}

	const postcode = extractPostcode(row.raw_payload) ?? "";
	const result = await geocoder.geocode(postcode);

	if (result.ok) {
		return casToGeocoded(db, id, result.coordinates, false);
	}

	return db.orm.transaction(async (tx) => {
		const updated = await tx.execute<{ id: string }>(sql`
			update forms
			set status = 'FAILED_GEOCODING', last_error = ${JSON.stringify({ reason: result.reason })}::jsonb, updated_at = now()
			where id = ${id} and status = 'VALIDATED'
			returning id
		`);
		if (updated.rows.length === 0) {
			return { outcome: "skipped" };
		}

		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, 'VALIDATED', 'FAILED_GEOCODING', ${null}::jsonb)
		`);
		return { outcome: "failed", reason: result.reason };
	});
}

async function casToGeocoded(
	db: Db,
	id: string,
	coordinates: { latitude: number; longitude: number } | null,
	cached: boolean,
): Promise<GeocodeOutcome> {
	return db.orm.transaction(async (tx) => {
		const updated = await tx.execute<{ id: string }>(
			coordinates === null
				? sql`
					update forms
					set status = 'GEOCODED', updated_at = now()
					where id = ${id} and status = 'VALIDATED'
					returning id
				`
				: sql`
					update forms
					set status = 'GEOCODED', latitude = ${coordinates.latitude}, longitude = ${coordinates.longitude}, updated_at = now()
					where id = ${id} and status = 'VALIDATED'
					returning id
				`,
		);
		if (updated.rows.length === 0) {
			return { outcome: "skipped" };
		}

		await tx.execute(sql`
			insert into form_events (form_id, from_status, to_status, detail)
			values (${id}, 'VALIDATED', 'GEOCODED', ${null}::jsonb)
		`);
		return { outcome: "geocoded", cached };
	});
}
