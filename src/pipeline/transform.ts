import type { IngestedFormV1 } from "../schemas/ingested/v1";
import type { TransformedFormSchema } from "../forms/schemas/transformed_schema";

const genderMap: Record<
	IngestedFormV1["gender"],
	TransformedFormSchema["gender"]
> = {
	male: "male",
	female: "female",
	other: "prefer-not-to-say",
};

export function transformForm(
	validated: IngestedFormV1,
	geo: { latitude: number; longitude: number },
): TransformedFormSchema {
	const [firstName = "", ...rest] = validated.name.trim().split(/\s+/);

	return {
		sessionId: validated.session_id,
		applicationReference: validated.application_reference,
		firstName,
		lastName: rest.join(" "),
		email: validated.email,
		gender: genderMap[validated.gender],
		dateOfBirth: new Date(validated.date_of_birth),
		phoneNumber: validated.phone_number,
		mobileNumber: validated.mobile_number,
		addressLine1: validated.address.address_line_1,
		addressLine2: validated.address.address_line_2,
		addressLine3: validated.address.address_line_3,
		postcode: validated.address.postcode,
		country: validated.address.country,
		longitude: geo.longitude,
		latitude: geo.latitude,
	};
}
