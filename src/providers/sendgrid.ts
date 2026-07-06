import { HttpResponse } from "./httpresponse";

export const sendEmail = async ({
	to,
	from,
	subject,
	body,
}: {
	to: string;
	from: string;
	subject: string;
	body: string;
}): Promise<HttpResponse<void>> => {
	// Generate a random number between 0 and 1
	const randomNumber = Math.random();

	// Simulating an asynchronous operation, e.g., sending an email
	await new Promise((resolve) => setTimeout(resolve, 1000));
	return {
		statusCode: randomNumber < 0.95 ? 200 : 500,
		body: undefined,
	};
};
