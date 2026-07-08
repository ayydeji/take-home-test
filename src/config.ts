export const config = {
	port: Number(process.env.PORT) || 3000,
	databaseUrl:
		process.env.DATABASE_URL ||
		"postgres://postgres:postgres@localhost:5432/forms",
	geocoder: {
		timeoutMs: Number(process.env.GEOCODER_TIMEOUT_MS) || 3000,
		attempts: Number(process.env.GEOCODER_ATTEMPTS) || 3,
		backoffMs: Number(process.env.GEOCODER_BACKOFF_MS) || 100,
	},
};
