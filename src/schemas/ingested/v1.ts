import { z } from "zod";

// src/forms/schemas/ingested_schema.ts (IngestedFormSchema) is the source of truth for these fields.
const base = z.object({
	session_id: z.string(),
	application_reference: z.string(),
	name: z.string(),
	email: z.string(),
	gender: z.enum(["male", "female", "other"]),
	date_of_birth: z.string(),
	phone_number: z.string().optional(),
	mobile_number: z.string(),
	address: z.object({
		address_line_1: z.string(),
		address_line_2: z.string(),
		address_line_3: z.string().optional(),
		postcode: z.string(),
		country: z.string(),
	}),
});

export type IngestedFormV1 = z.infer<typeof base>;

// Passthrough keeps unknown top-level keys instead of failing; validateIngested reports them.
export const ingestedV1 = base.passthrough();
