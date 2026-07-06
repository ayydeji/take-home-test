import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export const formStatus = pgEnum("form_status", [
	"RECEIVED",
	"VALIDATED",
	"GEOCODED",
	"READY",
	"DISPATCHED",
	"CONFLICT",
	"FAILED_VALIDATION",
	"FAILED_GEOCODING",
	"FAILED_TRANSFORM",
]);

export const forms = pgTable(
	"forms",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		providerFormId: text("provider_form_id"),
		contentHash: text("content_hash").notNull(),
		rawPayload: jsonb("raw_payload").notNull(),
		status: formStatus("status").notNull().default("RECEIVED"),
		schemaVersion: text("schema_version"),
		latitude: numeric("latitude"),
		longitude: numeric("longitude"),
		lastError: jsonb("last_error"),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		uniqueIndex("forms_content_hash_unique").on(t.contentHash),
		index("forms_provider_form_id_idx").on(t.providerFormId),
		index("forms_status_updated_at_idx").on(t.status, t.updatedAt),
	],
);

export const transformedForms = pgTable("transformed_forms", {
	id: uuid("id").primaryKey().defaultRandom(),
	formId: uuid("form_id")
		.notNull()
		.unique()
		.references(() => forms.id),
	payload: jsonb("payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const formEvents = pgTable("form_events", {
	id: uuid("id").primaryKey().defaultRandom(),
	formId: uuid("form_id")
		.notNull()
		.references(() => forms.id),
	fromStatus: text("from_status"),
	toStatus: text("to_status").notNull(),
	detail: jsonb("detail"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const outbox = pgTable(
	"outbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		formId: uuid("form_id")
			.notNull()
			.references(() => forms.id),
		type: text("type").notNull(),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		index("outbox_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt),
		check("outbox_status_check", sql`${t.status} in ('pending', 'sent')`),
	],
);
