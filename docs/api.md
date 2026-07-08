# API reference

Base URL in development: `http://localhost:3000`. All examples below are **real requests and responses**
captured against a running server (see [running.md](running.md) to start one). JSON bodies are
pretty-printed for readability; the server returns compact JSON.

## Authentication

Every route except `GET /health` requires an `x-api-key` header. Three scoped keys each open a disjoint set
of routes:

| Key (`x-api-key`)  | Opens                                                   |
| ------------------ | ------------------------------------------------------- |
| `PROVIDER_API_KEY` | `POST /ingest`                                          |
| `BOT_API_KEY`      | `POST /forms/ready`                                     |
| `OPS_API_KEY`      | `GET /forms/:id`, `GET /stats`, `POST /forms/:id/retry` |

- **Missing or unknown key → `401`**: `{"error":"missing api key"}` / `{"error":"invalid api key"}`
- **Valid key, wrong route → `403`**: `{"error":"key not authorized for this route"}`

Keys are compared in constant time (length-safe hash) and rate-limited to 300 requests/minute per key.

## Endpoints

| Method & path           | Scope    | Purpose                                                       |
| ----------------------- | -------- | ------------------------------------------------------------- |
| `GET /health`           | open     | liveness + database reachability                              |
| `POST /ingest`          | provider | ingest a raw form (stored before validation)                  |
| `GET /forms/:id`        | ops      | operational status view (no PII)                              |
| `GET /stats`            | ops      | drift dashboard: counts, oldest in-flight age, outbox backlog |
| `POST /forms/:id/retry` | ops      | replay a quarantined (`FAILED_*`) form                        |
| `POST /forms/ready`     | bot      | FORM-BOT claim: hand off `READY` forms, at most once          |

---

### `GET /health`

Open (no key). Returns `200` when the database is reachable, `503` otherwise.

```bash
curl localhost:3000/health
```

```json
{ "status": "ok" }
```

---

### `POST /ingest` — provider scope

Stores the raw payload immediately (before any validation) and kicks off processing in the background.
Idempotent: deduplicated by a canonical content hash.

```bash
curl -X POST localhost:3000/ingest \
  -H 'content-type: application/json' \
  -H 'x-api-key: <PROVIDER_API_KEY>' \
  --data-binary @tests/fixtures/valid-form.json
```

| Outcome                                    | Status | Body                                                                     |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| New form accepted                          | `202`  | `{"id":"f78fdca8-2cd6-48e8-94af-4cf15d03fcec"}`                          |
| Duplicate (same content)                   | `200`  | `{"id":"f78fdca8-…","duplicate":true}`                                   |
| Same `provider_form_id`, different content | `202`  | `{"id":"accd449b-…","conflict":true}` (parked at `CONFLICT` for a human) |
| Missing key                                | `401`  | `{"error":"missing api key"}`                                            |
| Wrong scope (e.g. bot key)                 | `403`  | `{"error":"key not authorized for this route"}`                          |
| Body over 1 MB                             | `413`  | `{"error":"payload too large"}`                                          |

A `202` means _accepted and stored_; the form then advances through the pipeline asynchronously — poll
`GET /forms/:id` to watch it reach `READY`.

---

### `GET /forms/:id` — ops scope

The operational view for triage. **Deliberately excludes `raw_payload`** — it is patient PII; this endpoint
is for operations, not data access.

```bash
curl localhost:3000/forms/f78fdca8-2cd6-48e8-94af-4cf15d03fcec \
  -H 'x-api-key: <OPS_API_KEY>'
```

```json
{
	"id": "f78fdca8-2cd6-48e8-94af-4cf15d03fcec",
	"status": "READY",
	"schema_version": "v1",
	"last_error": null,
	"received_at": "2026-07-08T13:38:10.111Z",
	"updated_at": "2026-07-08T13:38:11.203Z",
	"has_transformed": true
}
```

| Case                      | Status        | Body                          |
| ------------------------- | ------------- | ----------------------------- |
| Found                     | `200`         | the view above                |
| Unknown id (valid UUID)   | `404`         | `{"error":"form not found"}`  |
| Malformed id (not a UUID) | `400`         | `{"error":"invalid form id"}` |
| Missing key / wrong scope | `401` / `403` | as above                      |

---

### `GET /stats` — ops scope

The drift dashboard. `counts` is every status zero-filled; `oldest_non_terminal_age_seconds` is how long the
longest still-in-flight form has been in the system (`null` when none are in flight); `outbox_pending` is the
unsent-email backlog.

```bash
curl localhost:3000/stats -H 'x-api-key: <OPS_API_KEY>'
```

```json
{
	"counts": {
		"RECEIVED": 0,
		"VALIDATED": 0,
		"GEOCODED": 0,
		"READY": 2,
		"DISPATCHED": 0,
		"CONFLICT": 1,
		"FAILED_VALIDATION": 0,
		"FAILED_GEOCODING": 0,
		"FAILED_TRANSFORM": 0
	},
	"oldest_non_terminal_age_seconds": null,
	"outbox_pending": 0
}
```

A schema drift announces itself here: `FAILED_VALIDATION` climbs and `oldest_non_terminal_age_seconds` grows.

---

### `POST /forms/:id/retry` — ops scope

Replays a quarantined form after a code or schema fix. Resets it to the status _before_ the step that failed
(`FAILED_VALIDATION → RECEIVED`, `FAILED_GEOCODING → VALIDATED`, `FAILED_TRANSFORM → GEOCODED`), clears the
error, and re-enters the pipeline where it left off.

```bash
curl -X POST localhost:3000/forms/<id>/retry -H 'x-api-key: <OPS_API_KEY>'
```

| Case                                 | Status        | Body                         |
| ------------------------------------ | ------------- | ---------------------------- |
| Quarantined (`FAILED_*`) → retried   | `202`         | `{"id":"c2c292f1-…"}`        |
| Not in a failed state (e.g. `READY`) | `409`         | `{"status":"READY"}`         |
| Unknown id                           | `404`         | `{"error":"form not found"}` |
| Missing key / wrong scope            | `401` / `403` | as above                     |

---

### `POST /forms/ready` — bot scope

The FORM-BOT claim. Selects `READY` forms `FOR UPDATE SKIP LOCKED`, flips them to `DISPATCHED`, and returns
their transformed payloads — each form to exactly one caller even under concurrent bots. Optional
`?limit=<n>` (default 10, max 50). **The returned `payload` is the patient handoff body (PII).**

```bash
curl -X POST localhost:3000/forms/ready -H 'x-api-key: <BOT_API_KEY>'
```

```json
[
	{
		"id": "f78fdca8-2cd6-48e8-94af-4cf15d03fcec",
		"payload": {
			"sessionId": "sess_9f2a7c",
			"applicationReference": "GP-REG-2026-000042",
			"firstName": "Jordan",
			"lastName": "Alexander Rivera",
			"email": "jordan.rivera@example.com",
			"gender": "prefer-not-to-say",
			"dateOfBirth": "1990-03-15T00:00:00.000Z",
			"phoneNumber": "+44 20 7946 0958",
			"mobileNumber": "+44 7700 900123",
			"addressLine1": "12 Kingsway",
			"addressLine2": "Holborn",
			"addressLine3": "Camden",
			"postcode": "WC2B 6NH",
			"country": "United Kingdom",
			"latitude": -5.05,
			"longitude": 50.05
		}
	}
]
```

A second call with nothing left to claim returns `200 []`. Missing key → `401`; wrong scope (e.g. provider
key) → `403`. Once claimed, the form is `DISPATCHED` and will never be handed out again.
