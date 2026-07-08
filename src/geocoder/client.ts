import { HttpResponse } from "../providers/httpresponse";
import { lookupPostcode } from "../providers/idealpostcodes";
import { config } from "../config";

export type Coordinates = { latitude: number; longitude: number };

export type GeocodeResult =
	{ ok: true; coordinates: Coordinates } | { ok: false; reason: string };

export interface Geocoder {
	geocode(postcode: string): Promise<GeocodeResult>;
}

type RawLookup = (
	postcode: string,
	signal?: AbortSignal,
) => Promise<HttpResponse<Coordinates>>;

export type GeocoderConfig = {
	timeoutMs: number;
	attempts: number;
	backoffMs: number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class TimeoutError extends Error {}

async function withTimeout<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	// The provided mock ignores the signal, so the timeout is enforced by winning
	// this race — the mock's promise resolves later and is simply discarded. A real
	// HTTP client would receive the signal and cancel the in-flight request.
	const abort = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () =>
			reject(new TimeoutError()),
		);
	});

	try {
		return await Promise.race([run(controller.signal), abort]);
	} finally {
		clearTimeout(timer);
	}
}

export function createGeocoder(
	lookup: RawLookup,
	cfg: GeocoderConfig,
): Geocoder {
	return {
		async geocode(postcode: string): Promise<GeocodeResult> {
			let reason = "upstream_error";

			for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
				try {
					const response = await withTimeout(
						(signal) => lookup(postcode, signal),
						cfg.timeoutMs,
					);
					if (response.statusCode === 200 && response.body) {
						return { ok: true, coordinates: response.body };
					}
					reason = "upstream_error";
				} catch (err) {
					reason = err instanceof TimeoutError ? "timeout" : "upstream_error";
				}

				if (attempt < cfg.attempts) {
					const backoff = cfg.backoffMs * 2 ** (attempt - 1);
					await sleep(backoff + Math.random() * cfg.backoffMs);
				}
			}

			return { ok: false, reason };
		},
	};
}

export const defaultGeocoder = createGeocoder(lookupPostcode, config.geocoder);
