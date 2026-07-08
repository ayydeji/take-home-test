import pino from "pino";
import pinoHttp from "pino-http";

export type Logger = pino.Logger;

// Serializers whitelist exactly what may reach a log line — request bodies
// (patient PII) and headers (the api key) are never referenced, so no future
// change to the request object can leak them here. Redact is a second,
// belt-and-suspenders layer over the same fields.
export function createLogger(destination?: pino.DestinationStream): Logger {
	const options: pino.LoggerOptions = {
		serializers: {
			req: (req: { method: string; url: string }) => ({
				method: req.method,
				url: req.url,
			}),
			res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
		},
		redact: {
			paths: ["req.headers", "req.body", "req.remoteAddress"],
			remove: true,
		},
	};
	return destination ? pino(options, destination) : pino(options);
}

export function requestLogger(logger: Logger) {
	return pinoHttp({ logger });
}
