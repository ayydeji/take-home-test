import { z } from "zod";

// src/forms/schemas/transformed_schema.ts (TransformedFormSchema) is the source of truth for these fields.
const base = z.object({
	sessionId: z.string(),
	applicationReference: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	email: z.string(),
	gender: z.enum(["male", "female", "prefer-not-to-say"]),
	dateOfBirth: z.date(),
	phoneNumber: z.string().optional(),
	mobileNumber: z.string(),
	addressLine1: z.string(),
	addressLine2: z.string(),
	addressLine3: z.string().optional(),
	postcode: z.string(),
	country: z.string(),
	longitude: z.number(),
	latitude: z.number(),
});

export type TransformedFormV1 = z.infer<typeof base>;

export const transformedV1 = base;
