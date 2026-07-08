import { createHash, timingSafeEqual } from "node:crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";

export type Scope = "provider" | "bot" | "ops";

export type ApiKeyRing = {
	provider: string;
	bot: string;
	ops: string;
};

// Hashing both sides to a fixed 32-byte digest first means unequal-length
// input can never throw, so the comparison itself stays constant-time.
function timingSafeMatch(a: string, b: string): boolean {
	const digestA = createHash("sha256").update(a).digest();
	const digestB = createHash("sha256").update(b).digest();
	return timingSafeEqual(digestA, digestB);
}

function identifyKey(provided: string, keyring: ApiKeyRing): Scope | null {
	const scopes: Scope[] = ["provider", "bot", "ops"];
	for (const scope of scopes) {
		const configured = keyring[scope];
		if (configured.length > 0 && timingSafeMatch(provided, configured)) {
			return scope;
		}
	}
	return null;
}

export function requireScope(
	keyring: ApiKeyRing,
	required: Scope,
): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		const provided = req.header("x-api-key");
		if (!provided) {
			return res.status(401).json({ error: "missing api key" });
		}

		const scope = identifyKey(provided, keyring);
		if (scope === null) {
			return res.status(401).json({ error: "invalid api key" });
		}
		if (scope !== required) {
			return res
				.status(403)
				.json({ error: "key not authorized for this route" });
		}

		next();
	};
}
