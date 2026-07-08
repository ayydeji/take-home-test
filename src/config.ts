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
	sweeper: {
		intervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 15000,
		stalenessMs: Number(process.env.SWEEP_STALENESS_MS) || 60000,
	},
	outbox: {
		intervalMs: Number(process.env.OUTBOX_INTERVAL_MS) || 5000,
		backoffBaseMs: Number(process.env.OUTBOX_BACKOFF_BASE_MS) || 1000,
		backoffCapMs: Number(process.env.OUTBOX_BACKOFF_CAP_MS) || 300000,
	},
	apiKeys: {
		provider: process.env.PROVIDER_API_KEY || "",
		bot: process.env.BOT_API_KEY || "",
		ops: process.env.OPS_API_KEY || "",
	},
	rateLimit: {
		perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 300,
	},
};
