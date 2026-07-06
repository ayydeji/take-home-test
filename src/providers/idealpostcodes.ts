import { HttpResponse } from "./httpresponse";

export const lookupPostcode = async (
	postcode: string,
): Promise<HttpResponse<{ longitude: number; latitude: number }>> => {
	// Generate a random number between 0 and 1
	const randomNumber = Math.random();

	// Simulating an asynchronous operation, e.g., looking up a postcode
	await new Promise((resolve) => setTimeout(resolve, 1000));

	const success = randomNumber < 0.95;
	return {
		statusCode: success ? 200 : 500,
		body: success ? { longitude: 50.05, latitude: -5.05 } : undefined,
	};
};
